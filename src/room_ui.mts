// DOM wiring only. This module knows about element ids and how to update
// them; it knows nothing about signaling, WebRTC, or file transfer - those
// concerns live in index.mts, which is handed a RoomUi instance and talks
// to it only through this interface. Not unit tested, same as
// peer_connection.mts/file_sender.mts/file_receiver.mts - this is real DOM
// I/O, verified by using the app.
//
// Expects index.html to already contain the markup with the ids referenced
// below (see require_element calls). Room joining supports both manual
// room-code entry and scanning a QR code (the room creator's device shows
// a QR encoding a shareable join link; scanning it with a phone's native
// camera app opens the link, and index.mts auto-fills/auto-joins from the
// ?room= query param - no in-app camera scanner needed). Every device must
// choose a name before joining; the server enforces uniqueness per room,
// this module just does the immediate client-side sanity check.
//
// The "Use TURN relay" checkbox is read on every join click, whether
// creating or joining a room - on_join is the one handler for both. It
// only really matters at creation time (it sets the room's is_turn for
// its whole lifetime); when joining an existing room, the value sent must
// match what the room was created with or the server rejects it. A
// scanned/shared join link can pre-check this box via prefill_is_turn -
// index.mts reads a turn=1 query param (see qr_join.mts) and calls that
// before the user ever sees the form, so a joiner doesn't have to guess
// whether the room they're joining requires it.
//
// If the checkbox is checked, a one-time (per browser, via localStorage)
// accept/reject warning is shown before the join is ever sent, disclosing
// that traffic may be relayed through a third-party TURN server. Rejecting
// cancels the join entirely - on_join is never called, and nothing about
// the form's state changes. This whole flow is self-contained here:
// index.mts's on_join callback is unaware it happened, since from its
// perspective the callback is just invoked later than usual (or not at
// all) - same signature, no new wiring needed on that side.
//
// trigger_join() exists so index.mts's auto-join path (opening a scanned
// link with a device name already remembered) goes through this exact
// same validation/consent flow instead of bypassing it - it reads the
// same device-name/room-code/is_turn inputs a manual click would, so
// index.mts only needs to prefill those fields correctly beforehand.

import QRCode from "qrcode";

// Bootstrap's JS is loaded globally via CDN <script> in index.html (see
// index.html and the project's ways-of-working notes) rather than bundled
// through npm, so we only pull in its types here and reach the runtime
// class off `window.bootstrap`.
declare global {
  interface Window {
    bootstrap: typeof import("bootstrap");
  }
}

// Mirrors hopdrop-signaling's MAX_DEVICE_NAME_LENGTH - the server is the
// real enforcement point, but validating client-side first avoids a
// pointless round trip for an obviously-too-long name.
const MAX_DEVICE_NAME_LENGTH = 40;

// Presence-based flag, mirroring index.mts's DEVICE_NAME_STORAGE_KEY
// pattern - once set, the TURN warning modal is skipped on every future
// join click in this browser, regardless of which room or device name.
const TURN_WARNING_STORAGE_KEY = "hopdrop_turn_warning_acknowledged";

export interface PeerOption {
  device_id: string;
  device_name: string;
}

export interface RoomUiCallbacks {
  on_connect: (signaling_url: string) => void;
  on_disconnect: () => void;
  on_join: (
    device_name: string,
    room_code: string | undefined,
    is_turn: boolean,
  ) => void;
  on_leave: () => void;
  on_send_file: (target_device_id: string, file: File) => void;
}

export interface RoomUi {
  set_status(text: string): void;
  // Reflects the signaling socket's actual state (icon + connect/disconnect
  // button label), driven from index.mts's on_open/on_close handlers so it
  // stays correct whichever side closed the connection - a manual
  // disconnect and a server/network-initiated close both end up here via
  // the same WebSocket "close" event.
  set_connect_state(connected: boolean): void;
  // "disconnected": not connected to the signaling server at all.
  // "waiting": connected to signaling but not currently in a room.
  // "joined": in a room. Three states rather than a boolean so the icon
  // can distinguish "nothing to do yet" from "actively disconnected" -
  // otherwise leaving a room or having one expire looked identical to
  // losing the signaling connection entirely.
  set_room_status(state: "disconnected" | "waiting" | "joined"): void;
  log(label: string, data?: unknown): void;
  set_peer_options(peers: PeerOption[]): void;
  set_send_progress(percent: number, label: string): void;
  hide_send_progress(): void;
  add_downloaded_file(
    file_name: string,
    url: string,
    hash_verified: boolean,
  ): void;
  get_signaling_url(): string;
  prefill_room_code(room_code: string): void;
  prefill_is_turn(is_turn: boolean): void;
  get_device_name(): string;
  prefill_device_name(device_name: string): void;
  show_join_qr_code(join_url: string): Promise<void>;
  collapse_join_qr_code(): void;
  clear_join_qr_code(): void;
  // Runs the exact same validation/consent-gated flow a manual click on
  // the join button would - reads device name, room code, and the
  // use-turn checkbox straight from the DOM. Callers (index.mts's
  // auto-join path) must prefill those fields first; this does not accept
  // parameters of its own, specifically so there's only one join code
  // path to keep correct.
  trigger_join(): void;
}

function require_element<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) {
    throw new Error(`room_ui: expected an element with id "${id}" in the page`);
  }
  return el as T;
}

function has_acknowledged_turn_warning(): boolean {
  try {
    return localStorage.getItem(TURN_WARNING_STORAGE_KEY) !== null;
  } catch {
    // Storage access can throw (private browsing, disabled entirely) - if
    // we can't remember a prior acknowledgment, show the warning every
    // time rather than silently skipping a disclosure the user never
    // actually saw.
    return false;
  }
}

function mark_turn_warning_acknowledged(): void {
  try {
    localStorage.setItem(TURN_WARNING_STORAGE_KEY, "1");
  } catch {
    // Losing the "don't ask again" convenience isn't worth failing the
    // join over - the warning will just show again next time.
  }
}

export function create_room_ui(callbacks: RoomUiCallbacks): RoomUi {
  const ws_url_input = require_element<HTMLInputElement>("ws-url");
  const connect_button = require_element<HTMLButtonElement>("connect");
  const connect_status_el = require_element<HTMLElement>("connect-status");
  const device_name_input = require_element<HTMLInputElement>("device-name");
  const room_code_input = require_element<HTMLInputElement>("room-code");
  const use_turn_checkbox = require_element<HTMLInputElement>("use-turn");
  const join_button = require_element<HTMLButtonElement>("join");
  const room_status_el = require_element<HTMLElement>("room-status");
  const status_el = require_element<HTMLElement>("status");
  const peer_select = require_element<HTMLSelectElement>("peer-select");
  const file_input = require_element<HTMLInputElement>("file-input");
  const send_file_button = require_element<HTMLButtonElement>("send-file");
  const dropzone_el = require_element<HTMLElement>("dropzone");
  const dropzone_label_el = require_element<HTMLElement>("dropzone-label");
  const send_progress_el =
    require_element<HTMLProgressElement>("send-progress");
  const send_progress_label_el = require_element<HTMLElement>(
    "send-progress-label",
  );
  const log_el = require_element<HTMLElement>("log");
  const downloads_el = require_element<HTMLElement>("downloads");
  let downloads_has_content = false;
  const join_link_el = require_element<HTMLElement>("join-link");
  const qr_code_el = require_element<HTMLElement>("qr-code");
  const qr_details_el = require_element<HTMLDetailsElement>("qr-details");
  const qr_details_summary_maybe_el = qr_details_el.querySelector("summary");
  if (qr_details_summary_maybe_el === null) {
    throw new Error("room_ui: qr-details is missing its <summary>");
  }
  // Annotated (rather than relying on the null check above to narrow) so
  // the type stays non-null when referenced from the nested
  // expand/shrink_qr_details functions below - narrowing from a check
  // like the one above doesn't carry into a closure's own control-flow
  // analysis.
  const qr_details_summary_el: HTMLElement = qr_details_summary_maybe_el;
  const qr_details_content_el =
    require_element<HTMLElement>("qr-details-content");
  const turn_warning_modal_el =
    require_element<HTMLElement>("turn-warning-modal");
  // data-bs-backdrop="static"/data-bs-keyboard="false" on the element
  // itself keep Bootstrap's own dismiss paths (Escape, backdrop click)
  // disabled, preserving the "only way out is Accept/Reject" behavior -
  // Bootstrap's backdrop also handles dimming the rest of the page, so
  // there's no app-dimmed class to manage here anymore.
  const turn_warning_modal = new window.bootstrap.Modal(turn_warning_modal_el);
  const turn_warning_accept_button = require_element<HTMLButtonElement>(
    "turn-warning-accept",
  );
  const turn_warning_reject_button = require_element<HTMLButtonElement>(
    "turn-warning-reject",
  );

  // Animates the QR-code <details> open/closed instead of letting the
  // browser snap it instantly, which was disorienting - the surrounding
  // layout used to jump the instant the box appeared/disappeared. Follows
  // the standard WAAPI "animate a <details> element's height" pattern:
  // since the element's natural height isn't known in advance (the QR
  // code/join link content varies), each direction measures its own
  // start/end height from the live DOM rather than hard-coding one.
  let qr_details_animation: Animation | null = null;
  let qr_details_is_closing = false;
  let qr_details_is_expanding = false;

  function finish_qr_details_animation(open: boolean): void {
    qr_details_el.open = open;
    qr_details_animation = null;
    qr_details_is_closing = false;
    qr_details_is_expanding = false;
    qr_details_el.style.height = "";
    qr_details_el.style.overflow = "";
  }

  function expand_qr_details(): void {
    qr_details_is_expanding = true;
    const start_height = `${qr_details_el.offsetHeight}px`;
    const end_height = `${
      qr_details_summary_el.offsetHeight + qr_details_content_el.offsetHeight
    }px`;
    qr_details_animation?.cancel();
    qr_details_animation = qr_details_el.animate(
      { height: [start_height, end_height] },
      { duration: 200, easing: "ease-out" },
    );
    qr_details_animation.onfinish = () => finish_qr_details_animation(true);
    qr_details_animation.oncancel = () => {
      qr_details_is_expanding = false;
    };
  }

  function open_qr_details(): void {
    if (qr_details_el.open) {
      return;
    }
    qr_details_el.style.overflow = "hidden";
    qr_details_el.style.height = `${qr_details_el.offsetHeight}px`;
    qr_details_el.open = true;
    window.requestAnimationFrame(() => expand_qr_details());
  }

  function shrink_qr_details(on_closed?: () => void): void {
    qr_details_is_closing = true;
    const start_height = `${qr_details_el.offsetHeight}px`;
    const end_height = `${qr_details_summary_el.offsetHeight}px`;
    qr_details_animation?.cancel();
    qr_details_animation = qr_details_el.animate(
      { height: [start_height, end_height] },
      { duration: 200, easing: "ease-out" },
    );
    qr_details_animation.onfinish = () => {
      finish_qr_details_animation(false);
      on_closed?.();
    };
    qr_details_animation.oncancel = () => {
      qr_details_is_closing = false;
    };
  }

  // on_closed (used by clear_join_qr_code, below) runs only once the box
  // has actually finished closing - clearing the QR code/join link
  // straight away, before the collapse animation runs, left nothing for
  // it to animate: the box had already snapped down to its emptied
  // content's height, so the close looked like an instant jump.
  function close_qr_details(on_closed?: () => void): void {
    if (!qr_details_el.open) {
      on_closed?.();
      return;
    }
    qr_details_el.style.overflow = "hidden";
    shrink_qr_details(on_closed);
  }

  qr_details_summary_el.addEventListener("click", (event) => {
    event.preventDefault();
    if (qr_details_is_closing || !qr_details_el.open) {
      open_qr_details();
    } else if (qr_details_is_expanding || qr_details_el.open) {
      close_qr_details();
    }
  });

  function ui_log(label: string, data?: unknown): void {
    const line = `[${new Date().toLocaleTimeString()}] ${label}${
      data !== undefined ? " " + JSON.stringify(data) : ""
    }`;
    log_el.textContent += line + "\n";
    log_el.scrollTop = log_el.scrollHeight;
  }

  // Resolves true if the user clicks "I Understand", false if they click
  // "Reject". No other way to dismiss this exists - no backdrop element,
  // no Escape handler - so an explicit choice is the only path out.
  function show_turn_warning_modal(): Promise<boolean> {
    return new Promise((resolve) => {
      function on_accept(): void {
        cleanup();
        resolve(true);
      }
      function on_reject(): void {
        cleanup();
        resolve(false);
      }
      function cleanup(): void {
        turn_warning_modal.hide();
        turn_warning_accept_button.removeEventListener("click", on_accept);
        turn_warning_reject_button.removeEventListener("click", on_reject);
      }
      turn_warning_accept_button.addEventListener("click", on_accept);
      turn_warning_reject_button.addEventListener("click", on_reject);
      turn_warning_modal.show();
    });
  }

  // Shared by the join button's click listener and trigger_join() - both
  // must go through the identical validation/consent flow, reading
  // straight from the DOM inputs rather than accepting parameters, so
  // there's exactly one place this logic exists.
  async function attempt_join(): Promise<void> {
    const device_name = device_name_input.value.trim();
    if (device_name.length === 0) {
      ui_log("enter a device name first");
      return;
    }
    if (device_name.length > MAX_DEVICE_NAME_LENGTH) {
      ui_log(
        `device name must be ${MAX_DEVICE_NAME_LENGTH} characters or fewer`,
      );
      return;
    }
    const room_code = room_code_input.value.trim() || undefined;
    const is_turn = use_turn_checkbox.checked;

    if (is_turn && !has_acknowledged_turn_warning()) {
      const accepted = await show_turn_warning_modal();
      if (!accepted) {
        ui_log("TURN relay declined - join not sent");
        return;
      }
      mark_turn_warning_acknowledged();
      ui_log("TURN relay use acknowledged");
    }

    callbacks.on_join(device_name, room_code, is_turn);
  }

  let is_connected = false;

  connect_button.addEventListener("click", () => {
    if (is_connected) {
      callbacks.on_disconnect();
    } else {
      callbacks.on_connect(ws_url_input.value);
    }
  });

  let is_joined = false;

  join_button.addEventListener("click", () => {
    if (is_joined) {
      callbacks.on_leave();
    } else {
      void attempt_join();
    }
  });

  // Shows the chosen file's name in the dropzone, replacing the
  // drag/browse prompt - used whether the file came from a click-to-browse
  // (native file picker -> file-input's own "change" event) or a drag/drop
  // (file-input.files is set manually below, which does not fire "change",
  // so this is called directly in that path too).
  function show_dropped_file(file: File | undefined): void {
    if (file === undefined) {
      dropzone_label_el.innerHTML =
        'Drag &amp; drop a file here, or <span class="text-accent-2">click to browse</span>';
      return;
    }
    dropzone_label_el.textContent = file.name;
  }

  dropzone_el.addEventListener("click", () => {
    file_input.click();
  });
  dropzone_el.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      file_input.click();
    }
  });
  file_input.addEventListener("change", () => {
    show_dropped_file(file_input.files?.[0]);
  });
  dropzone_el.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropzone_el.classList.add("border-accent-subtle", "bg-accent-2-subtle");
  });
  dropzone_el.addEventListener("dragleave", () => {
    dropzone_el.classList.remove("border-accent-subtle", "bg-accent-2-subtle");
  });
  dropzone_el.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone_el.classList.remove("border-accent-subtle", "bg-accent-2-subtle");
    const data_transfer = event.dataTransfer;
    const dropped_file = data_transfer?.files?.[0];
    if (data_transfer === null || dropped_file === undefined) {
      return;
    }
    file_input.files = data_transfer.files;
    show_dropped_file(dropped_file);
  });

  send_file_button.addEventListener("click", () => {
    const device_id = peer_select.value;
    const file = file_input.files?.[0];
    if (device_id === "") {
      ui_log("select a peer first");
      return;
    }
    if (file === undefined) {
      ui_log("choose a file first");
      return;
    }
    callbacks.on_send_file(device_id, file);
  });

  return {
    set_status(text) {
      status_el.textContent = text;
    },

    set_connect_state(connected) {
      is_connected = connected;
      if (connected) {
        connect_status_el.classList.remove("bi-x-circle-fill", "text-danger");
        connect_status_el.classList.add("bi-check-circle-fill", "text-success");
        connect_button.textContent = "Disconnect";
      } else {
        connect_status_el.classList.remove(
          "bi-check-circle-fill",
          "text-success",
        );
        connect_status_el.classList.add("bi-x-circle-fill", "text-danger");
        connect_button.textContent = "Connect";
      }
    },

    set_room_status(state) {
      is_joined = state === "joined";
      room_status_el.classList.remove(
        "bi-x-circle-fill",
        "text-danger",
        "bi-dash-circle-fill",
        "text-accent",
        "bi-check-circle-fill",
        "text-success",
      );
      if (state === "joined") {
        room_status_el.classList.add("bi-check-circle-fill", "text-success");
        join_button.textContent = "Leave";
      } else if (state === "waiting") {
        room_status_el.classList.add("bi-dash-circle-fill", "text-accent");
        room_code_input.value = "";
        join_button.textContent = "Join";
      } else {
        room_status_el.classList.add("bi-x-circle-fill", "text-danger");
        room_code_input.value = "";
        join_button.textContent = "Join";
      }
    },

    log: ui_log,

    set_peer_options(peers) {
      peer_select.innerHTML = "";
      if (peers.length === 0) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "(no open channels yet)";
        peer_select.appendChild(opt);
        return;
      }
      for (const peer of peers) {
        const opt = document.createElement("option");
        opt.value = peer.device_id;
        opt.textContent = peer.device_name;
        peer_select.appendChild(opt);
      }
    },

    set_send_progress(percent, label) {
      send_progress_el.style.display = "inline-block";
      send_progress_el.value = percent;
      send_progress_label_el.textContent = label;
    },

    hide_send_progress() {
      send_progress_el.style.display = "none";
      send_progress_label_el.textContent = "";
    },

    add_downloaded_file(file_name, url, hash_verified) {
      if (!downloads_has_content) {
        downloads_el.innerHTML = "";
        downloads_has_content = true;
      }

      const link = document.createElement("a");
      link.href = url;
      link.download = file_name;
      link.className = hash_verified
        ? "verified link-light"
        : "unverified link-light";
      link.textContent = `${file_name} ${
        hash_verified ? "(hash verified)" : "(HASH MISMATCH)"
      }`;
      const li = document.createElement("li");
      li.className = "list-group-item bg-transparent px-0";
      li.appendChild(link);
      downloads_el.appendChild(li);
    },

    get_signaling_url() {
      return ws_url_input.value;
    },

    prefill_room_code(room_code) {
      room_code_input.value = room_code;
    },

    prefill_is_turn(is_turn) {
      use_turn_checkbox.checked = is_turn;
    },

    get_device_name() {
      return device_name_input.value.trim();
    },

    prefill_device_name(device_name) {
      device_name_input.value = device_name;
    },

    async show_join_qr_code(join_url) {
      const svg = await QRCode.toString(join_url, { type: "svg" });
      qr_code_el.innerHTML = svg;
      join_link_el.textContent = join_url;
      open_qr_details();
    },

    collapse_join_qr_code() {
      close_qr_details();
    },

    clear_join_qr_code() {
      close_qr_details(() => {
        qr_code_el.innerHTML = "";
        join_link_el.textContent = "";
      });
    },

    trigger_join() {
      void attempt_join();
    },
  };
}
