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

import QRCode from "qrcode";

// Mirrors hopdrop-signaling's MAX_DEVICE_NAME_LENGTH - the server is the
// real enforcement point, but validating client-side first avoids a
// pointless round trip for an obviously-too-long name.
const MAX_DEVICE_NAME_LENGTH = 40;

export interface PeerOption {
  device_id: string;
  device_name: string;
}

export interface RoomUiCallbacks {
  on_connect: (signaling_url: string) => void;
  on_join: (device_name: string, room_code: string | undefined) => void;
  on_leave: () => void;
  on_send_file: (target_device_id: string, file: File) => void;
}

export interface RoomUi {
  set_status(text: string): void;
  set_connected_status(): void;
  set_room_status(joined: boolean): void;
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
  get_device_name(): string;
  prefill_device_name(device_name: string): void;
  show_join_qr_code(join_url: string): Promise<void>;
  collapse_join_qr_code(): void;
  clear_join_qr_code(): void;
}

function require_element<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) {
    throw new Error(`room_ui: expected an element with id "${id}" in the page`);
  }
  return el as T;
}

export function create_room_ui(callbacks: RoomUiCallbacks): RoomUi {
  const ws_url_input = require_element<HTMLInputElement>("ws-url");
  const connect_button = require_element<HTMLButtonElement>("connect");
  const connect_status_el = require_element<HTMLElement>("connect-status");
  const device_name_input = require_element<HTMLInputElement>("device-name");
  const room_code_input = require_element<HTMLInputElement>("room-code");
  const join_button = require_element<HTMLButtonElement>("join");
  const leave_button = require_element<HTMLButtonElement>("leave");
  const room_status_el = require_element<HTMLElement>("room-status");
  const status_el = require_element<HTMLElement>("status");
  const peer_select = require_element<HTMLSelectElement>("peer-select");
  const file_input = require_element<HTMLInputElement>("file-input");
  const send_file_button = require_element<HTMLButtonElement>("send-file");
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

  function ui_log(label: string, data?: unknown): void {
    const line = `[${new Date().toLocaleTimeString()}] ${label}${
      data !== undefined ? " " + JSON.stringify(data) : ""
    }`;
    log_el.textContent += line + "\n";
    log_el.scrollTop = log_el.scrollHeight;
  }

  connect_button.addEventListener("click", () => {
    callbacks.on_connect(ws_url_input.value);
  });

  join_button.addEventListener("click", () => {
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
    callbacks.on_join(device_name, room_code);
  });

  leave_button.addEventListener("click", () => {
    callbacks.on_leave();
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

    set_connected_status() {
      connect_status_el.classList.remove("bi-x-circle");
      connect_status_el.classList.add("bi-hand-thumbs-up-fill");
    },

    set_room_status(joined: boolean) {
      if (joined) {
        room_status_el.classList.remove("bi-x-circle");
        room_status_el.classList.add("bi-hand-thumbs-up-fill");
      } else {
        room_status_el.classList.remove("bi-hand-thumbs-up-fill");
        room_status_el.classList.add("bi-x-circle");
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
      li.appendChild(link);
      downloads_el.appendChild(li);
    },

    get_signaling_url() {
      return ws_url_input.value;
    },

    prefill_room_code(room_code) {
      room_code_input.value = room_code;
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
      qr_details_el.open = true;
    },

    collapse_join_qr_code() {
      qr_details_el.open = false;
    },

    clear_join_qr_code() {
      qr_code_el.innerHTML = "";
      join_link_el.textContent = "";
      qr_details_el.open = false;
    },
  };
}
