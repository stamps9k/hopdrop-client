// DOM wiring only. This module knows about element ids and how to update
// them; it knows nothing about signaling, WebRTC, or file transfer - those
// concerns live in index.mts, which is handed a RoomUi instance and talks
// to it only through this interface. Not unit tested, same as
// peer_connection.mts/file_sender.mts/file_receiver.mts - this is real DOM
// I/O, verified by using the app.
//
// Expects index.html to already contain the markup with the ids referenced
// below (see require_element calls). No QR pairing yet - room codes are
// plain text entry/display for now; can be layered on later without
// changing this module's callback interface.

export interface RoomUiCallbacks {
  on_connect: (signaling_url: string) => void;
  on_join: (room_code: string | undefined) => void;
  on_leave: () => void;
  on_send_file: (target_device_id: string, file: File) => void;
}

export interface RoomUi {
  set_status(text: string): void;
  log(label: string, data?: unknown): void;
  set_peer_options(device_ids: string[]): void;
  set_send_progress(percent: number, label: string): void;
  hide_send_progress(): void;
  add_downloaded_file(
    file_name: string,
    url: string,
    hash_verified: boolean,
  ): void;
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
  const room_code_input = require_element<HTMLInputElement>("room-code");
  const join_button = require_element<HTMLButtonElement>("join");
  const leave_button = require_element<HTMLButtonElement>("leave");
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
    const room_code = room_code_input.value.trim() || undefined;
    callbacks.on_join(room_code);
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

    log: ui_log,

    set_peer_options(device_ids) {
      peer_select.innerHTML = "";
      if (device_ids.length === 0) {
        const opt = document.createElement("option");
        opt.value = "";
        opt.textContent = "(no open channels yet)";
        peer_select.appendChild(opt);
        return;
      }
      for (const device_id of device_ids) {
        const opt = document.createElement("option");
        opt.value = device_id;
        opt.textContent = device_id;
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
      const link = document.createElement("a");
      link.href = url;
      link.download = file_name;
      link.className = hash_verified ? "verified" : "unverified";
      link.textContent = `${file_name} ${
        hash_verified ? "(hash verified)" : "(HASH MISMATCH)"
      }`;
      downloads_el.appendChild(link);
    },
  };
}
