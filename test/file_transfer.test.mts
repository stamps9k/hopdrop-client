// Runs file_sender.mts and file_receiver.mts against each other over a pair
// of fake data channels: in-memory stand-ins for RTCDataChannel that pass
// messages to each other asynchronously, can be closed, can hold their send
// buffer "full", and let a test intercept, corrupt or drop messages in
// transit.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  ChannelClosedError,
  confirmation_timeout_for,
  send_file,
  type FileSendProgress,
} from "../src/file_sender.mjs";
import {
  attach_file_receiver,
  TransferInterruptedError,
  type FileReceiveComplete,
  type FileReceiver,
} from "../src/file_receiver.mjs";
import { build_file_complete_message } from "../src/file_transfer_protocol.mjs";
import { DEFAULT_CHUNK_SIZE_BYTES } from "../src/chunking.mjs";

type Payload = string | ArrayBuffer;
// Returns the message to deliver (possibly modified), or null to drop it.
type Intercept = (payload: Payload) => Payload | null;

class FakeChannel extends EventTarget {
  readyState: RTCDataChannelState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType: BinaryType = "arraybuffer";
  peer: FakeChannel | undefined;
  intercept: Intercept = (payload) => payload;
  sent: Payload[] = [];

  send(data: string | ArrayBufferView | ArrayBuffer): void {
    if (this.readyState !== "open") {
      throw new Error("InvalidStateError: channel is not open");
    }
    const payload: Payload =
      typeof data === "string"
        ? data
        : ArrayBuffer.isView(data)
          ? new Uint8Array(
              data.buffer,
              data.byteOffset,
              data.byteLength,
            ).slice().buffer
          : data.slice(0);
    this.sent.push(payload);
    const delivered = this.intercept(payload);
    const peer = this.peer;
    if (delivered === null || peer === undefined) {
      return;
    }
    // Asynchronous, in order - like a real ordered/reliable channel.
    setTimeout(() => {
      if (peer.readyState === "open") {
        peer.dispatchEvent(new MessageEvent("message", { data: delivered }));
      }
    }, 0);
  }

  close(): void {
    for (const end of [this, this.peer]) {
      if (end !== undefined && end.readyState === "open") {
        end.readyState = "closed";
        end.dispatchEvent(new Event("close"));
      }
    }
  }

  // Simulates the send buffer emptying after being held full.
  drain(): void {
    this.bufferedAmount = 0;
    this.dispatchEvent(new Event("bufferedamountlow"));
  }
}

function as_channel(fake: FakeChannel): RTCDataChannel {
  return fake as unknown as RTCDataChannel;
}

function channel_pair(): { sender: FakeChannel; receiver: FakeChannel } {
  const sender = new FakeChannel();
  const receiver = new FakeChannel();
  sender.peer = receiver;
  receiver.peer = sender;
  return { sender, receiver };
}

interface ReceiverLog {
  completed: FileReceiveComplete[];
  errors: Error[];
  receiver: FileReceiver;
}

function attach_receiver(channel: FakeChannel): ReceiverLog {
  const completed: FileReceiveComplete[] = [];
  const errors: Error[] = [];
  const receiver = attach_file_receiver(as_channel(channel), {
    on_complete: (result) => completed.push(result),
    on_error: (error) => errors.push(error),
  });
  return { completed, errors, receiver };
}

function file_of(size: number, name = "test.bin"): File {
  const bytes = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    bytes[i] = (i * 31 + 7) % 256;
  }
  return new File([bytes], name);
}

function is_chunk(payload: Payload): payload is ArrayBuffer {
  return payload instanceof ArrayBuffer;
}

function is_confirmation(payload: Payload): boolean {
  return typeof payload === "string" && payload.includes('"file-complete"');
}

function settle_messages(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe("send_file + attach_file_receiver", () => {
  test("delivers a multi-chunk file and reports it confirmed", async () => {
    const { sender, receiver } = channel_pair();
    const received = attach_receiver(receiver);
    const file = file_of(DEFAULT_CHUNK_SIZE_BYTES * 5 + 123);
    const events: string[] = [];
    const progress: FileSendProgress[] = [];

    const result = await send_file(as_channel(sender), file, {
      on_progress: (p) => progress.push(p),
      on_sent: () => events.push("sent"),
      on_complete: () => events.push("complete"),
      on_error: () => events.push("error"),
    });

    assert.deepEqual(result, { file_name: "test.bin", hash_verified: true });
    assert.deepEqual(events, ["sent", "complete"]);
    assert.equal(progress.length, 6);
    assert.equal(progress.at(-1)?.bytes_sent, file.size);
    assert.equal(received.completed.length, 1);
    const blob = received.completed[0]?.blob;
    assert.ok(blob);
    assert.deepEqual(
      new Uint8Array(await blob.arrayBuffer()),
      new Uint8Array(await file.arrayBuffer()),
    );
    assert.deepEqual(received.errors, []);
  });

  test("delivers a zero-byte file", async () => {
    const { sender, receiver } = channel_pair();
    const received = attach_receiver(receiver);
    const result = await send_file(as_channel(sender), file_of(0, "empty"));
    assert.deepEqual(result, { file_name: "empty", hash_verified: true });
    assert.equal(received.completed[0]?.bytes_received, 0);
  });

  test("reports a file corrupted in transit as not verified", async () => {
    const { sender, receiver } = channel_pair();
    const received = attach_receiver(receiver);
    let corrupted = false;
    sender.intercept = (payload) => {
      if (!corrupted && is_chunk(payload)) {
        corrupted = true;
        const bytes = new Uint8Array(payload);
        bytes[0] = (bytes[0] ?? 0) ^ 0xff;
      }
      return payload;
    };

    const result = await send_file(as_channel(sender), file_of(1000));
    assert.equal(result.hash_verified, false);
    assert.equal(received.completed[0]?.hash_verified, false);
  });

  test("the receiver ignores confirmations meant for its own sends", async () => {
    const { sender, receiver } = channel_pair();
    const received = attach_receiver(receiver);
    sender.send(
      build_file_complete_message({
        file_name: "x",
        sha256_hex: "00",
        hash_verified: true,
      }),
    );
    await settle_messages();
    assert.deepEqual(received.errors, []);
  });

  test("a confirmation arriving before the buffer drains still counts", async () => {
    const { sender, receiver } = channel_pair();
    attach_receiver(receiver);
    // Hold the buffer "full" once the last chunk is out, so the receiver's
    // confirmation arrives while the sender is still waiting to drain.
    let chunks_seen = 0;
    sender.intercept = (payload) => {
      if (is_chunk(payload) && ++chunks_seen === 2) {
        sender.bufferedAmount = 1;
      }
      return payload;
    };
    const sending = send_file(
      as_channel(sender),
      file_of(DEFAULT_CHUNK_SIZE_BYTES + 1),
      {},
      { confirmation_timeout_ms: 1000 },
    );
    await settle_messages();
    assert.equal(sender.sent.length, 3, "start + 2 chunks sent");
    sender.drain();
    assert.equal((await sending).hash_verified, true);
  });

  test("a finished send frees the channel for the next one", async () => {
    const { sender, receiver } = channel_pair();
    const received = attach_receiver(receiver);
    await send_file(as_channel(sender), file_of(100, "one"));
    await send_file(as_channel(sender), file_of(100, "one"));
    assert.equal(received.completed.length, 2);
  });
});

describe("send_file failures", () => {
  test("rejects a second send on a busy channel, without disturbing the first", async () => {
    const { sender, receiver } = channel_pair();
    const received = attach_receiver(receiver);
    const first = send_file(as_channel(sender), file_of(50_000, "first"));
    const errors: Error[] = [];
    await assert.rejects(
      send_file(as_channel(sender), file_of(10, "second"), {
        on_error: (error) => errors.push(error),
      }),
      /already being sent/,
    );
    assert.equal(errors.length, 1);
    assert.equal((await first).hash_verified, true);
    assert.deepEqual(
      received.completed.map((r) => r.file_name),
      ["first"],
    );
  });

  test("fails when the channel closes mid-transfer", async () => {
    const { sender, receiver } = channel_pair();
    attach_receiver(receiver);
    let chunks_seen = 0;
    sender.intercept = (payload) => {
      if (is_chunk(payload) && ++chunks_seen === 2) {
        setTimeout(() => sender.close(), 0);
        sender.bufferedAmount = Number.MAX_SAFE_INTEGER;
      }
      return payload;
    };
    const events: string[] = [];
    await assert.rejects(
      send_file(
        as_channel(sender),
        file_of(DEFAULT_CHUNK_SIZE_BYTES * 4),
        {
          on_sent: () => events.push("sent"),
          on_complete: () => events.push("complete"),
          on_error: () => events.push("error"),
        },
        { buffered_amount_low_threshold: 0 },
      ),
      ChannelClosedError,
    );
    assert.deepEqual(events, ["error"]);
  });

  test("fails when the channel closes before the receiver confirms", async () => {
    const { sender, receiver } = channel_pair();
    attach_receiver(receiver);
    receiver.intercept = (payload) => {
      if (is_confirmation(payload)) {
        setTimeout(() => receiver.close(), 0);
        return null;
      }
      return payload;
    };
    const events: string[] = [];
    await assert.rejects(
      send_file(as_channel(sender), file_of(100), {
        on_sent: () => events.push("sent"),
        on_error: () => events.push("error"),
      }),
      /before the other device confirmed receipt/,
    );
    assert.deepEqual(events, ["sent", "error"]);
  });

  test("fails if no confirmation arrives in time (e.g. an older receiver)", async () => {
    const { sender, receiver } = channel_pair();
    attach_receiver(receiver);
    receiver.intercept = (payload) =>
      is_confirmation(payload) ? null : payload;
    await assert.rejects(
      send_file(
        as_channel(sender),
        file_of(100),
        {},
        {
          confirmation_timeout_ms: 50,
        },
      ),
      /didn't confirm receipt in time/,
    );
  });

  test("ignores a confirmation for a different transfer", async () => {
    const { sender, receiver } = channel_pair();
    attach_receiver(receiver);
    receiver.intercept = (payload) => {
      if (!is_confirmation(payload)) return payload;
      return build_file_complete_message({
        file_name: "test.bin",
        sha256_hex: "not-this-file",
        hash_verified: true,
      });
    };
    await assert.rejects(
      send_file(
        as_channel(sender),
        file_of(100),
        {},
        {
          confirmation_timeout_ms: 50,
        },
      ),
      /didn't confirm receipt in time/,
    );
  });

  test("fails straight away on a channel that isn't open", async () => {
    const { sender } = channel_pair();
    sender.readyState = "closed";
    await assert.rejects(
      send_file(as_channel(sender), file_of(10)),
      /not "open"/,
    );
    // ...and doesn't leave the channel marked busy.
    sender.readyState = "open";
    attach_receiver(sender.peer ?? new FakeChannel());
    await send_file(as_channel(sender), file_of(10));
  });
});

describe("confirmation_timeout_for", () => {
  test("is 15 s plus a second per started 50 MB", () => {
    assert.equal(confirmation_timeout_for(0), 15_000);
    assert.equal(confirmation_timeout_for(1), 16_000);
    assert.equal(confirmation_timeout_for(50 * 1024 * 1024), 16_000);
    assert.equal(confirmation_timeout_for(50 * 1024 * 1024 + 1), 17_000);
    assert.equal(confirmation_timeout_for(2 * 1024 ** 3), 56_000);
  });
});

describe("attach_file_receiver interruptions", () => {
  // Sends a file, closing the channel (or running `interrupt`) once a
  // couple of chunks have arrived - i.e. part-way through.
  async function interrupt_after_two_chunks(
    interrupt: (sender: FakeChannel, received: ReceiverLog) => void,
  ): Promise<ReceiverLog> {
    const { sender, receiver } = channel_pair();
    const received = attach_receiver(receiver);
    let chunks_seen = 0;
    sender.intercept = (payload) => {
      if (is_chunk(payload) && ++chunks_seen === 3) {
        interrupt(sender, received);
        return null;
      }
      return payload;
    };
    await send_file(
      as_channel(sender),
      file_of(DEFAULT_CHUNK_SIZE_BYTES * 6, "photo.jpg"),
      {},
      { confirmation_timeout_ms: 50 },
    ).catch(() => undefined);
    await settle_messages();
    return received;
  }

  test("reports a file cut off by the channel closing", async () => {
    const received = await interrupt_after_two_chunks((sender) =>
      setTimeout(() => sender.close(), 10),
    );
    assert.deepEqual(received.completed, []);
    assert.equal(received.errors.length, 1);
    const error = received.errors[0];
    assert.ok(error instanceof TransferInterruptedError);
    assert.equal(error.file_name, "photo.jpg");
  });

  test("reports a file cut off by the receiver being detached", async () => {
    const received = await interrupt_after_two_chunks((_sender, log) =>
      setTimeout(() => log.receiver.detach(), 10),
    );
    assert.equal(received.errors.length, 1);
    assert.ok(received.errors[0] instanceof TransferInterruptedError);
  });

  test("reports an interruption only once, however the receiver is shut down", async () => {
    const received = await interrupt_after_two_chunks((sender, log) =>
      setTimeout(() => {
        log.receiver.detach();
        sender.close();
        log.receiver.detach();
      }, 10),
    );
    assert.equal(received.errors.length, 1);
  });

  test("reports nothing when closed between files", async () => {
    const { sender, receiver } = channel_pair();
    const received = attach_receiver(receiver);
    await send_file(as_channel(sender), file_of(100));
    sender.close();
    received.receiver.detach();
    assert.equal(received.completed.length, 1);
    assert.deepEqual(received.errors, []);
  });
});
