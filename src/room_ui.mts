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
// link's fragment - see qr_join.mts - no in-app camera scanner needed). Every device must
// choose a name before joining; the server enforces uniqueness per room,
// this module just does the immediate client-side sanity check.
//
// The "Use TURN relay" checkbox is read on every join click, whether
// creating or joining a room - on_join is the one handler for both. It
// only really matters at creation time (it sets the room's is_turn for
// its whole lifetime); when joining an existing room, the value sent must
// match what the room was created with or the server rejects it. A
// scanned/shared join link can pre-check this box via prefill_is_turn -
// index.mts reads the link's turn flag (see qr_join.mts) and calls that
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
// The warning is acknowledged per signaling server: the default server's
// acknowledgment doesn't carry over to a third-party one, because a
// third-party server supplies its own TURN credentials and so chooses the
// relay - the modal gains a paragraph saying so for that case.
//
// show_join_guide() is the friendlier front door for the same flow when a
// join link is opened on a device with no remembered name: a focused
// modal asking only for a device name, which then fills in the form and
// runs the normal join. If the server rejects the join (e.g. the name is
// already taken in that room), index.mts reports it back through
// report_join_guide_result and the modal reopens with the error.
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
  // false when the connection was negotiated over unencrypted signaling
  // (one side joined by typed room code), so it can't be ruled out that
  // the signaling server tampered with it.
  verified: boolean;
}

// What the Send tab's progress bar shows. The selected file's name is
// tracked here in room_ui.mts (it changes on file selection, without
// index.mts being involved), so the states don't carry it.
//   idle        empty bar - nothing sent yet since the file was chosen
//   sending     orange, animated stripes, filling as chunks go out
//   confirming  orange, full, waiting for the receiver to confirm
//   delivered   green - the receiver confirmed the file and its hash
//   failed      red, with the reason underneath
export type SendState =
  | { kind: "idle" }
  | { kind: "sending"; percent: number }
  | { kind: "confirming" }
  | { kind: "delivered"; recipient: string }
  | { kind: "failed"; reason: string };

export type ToastVariant = "success" | "danger";

export interface RoomUiCallbacks {
  on_connect: (signaling_url: string) => void;
  on_disconnect: () => void;
  // Resolves true once the join message has actually been sent, false if
  // it was abandoned (not connected, room key setup failed).
  on_join: (
    device_name: string,
    room_code: string | undefined,
    is_turn: boolean,
  ) => Promise<boolean>;
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
  // Sending and confirming also lock the file picker and Send button, so a
  // new file can't be chosen or sent until the transfer has finished.
  set_send_state(state: SendState): void;
  // A short notice in the corner that fades after 5 seconds, visible
  // whichever tab is open.
  show_toast(variant: ToastVariant, message: string): void;
  add_downloaded_file(
    file_name: string,
    url: string,
    hash_verified: boolean,
  ): void;
  get_signaling_url(): string;
  // The build's default signaling URL - the ws-url input's original value
  // attribute (Vite substitutes VITE_SIGNALING_URL into it), unaffected by
  // anything the user has typed since.
  get_default_signaling_url(): string;
  prefill_signaling_url(url: string): void;
  // undefined: connected to the default server (or not connected) - no
  // notice. Otherwise shows a standing, non-blocking warning naming the
  // third-party server and what it can see.
  set_third_party_signaling_url(url: string | undefined): void;
  show_signaling_tamper_warning(peer_name: string): void;
  clear_signaling_tamper_warning(): void;
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
  // Opens the focused join modal for a scanned/shared link (see the file
  // header). Only the device name is asked for - room code, TURN flag and
  // server are already prefilled from the link.
  show_join_guide(room_code: string): void;
  // Outcome of the join the guide sent: ok closes the loop; an error
  // message reopens the guide showing it. Ignored unless a guided join is
  // actually in flight, so unrelated server errors never pop it open.
  report_join_guide_result(error_message?: string): void;
  show_send_tab(): void;
}

function require_element<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (el === null) {
    throw new Error(`room_ui: expected an element with id "${id}" in the page`);
  }
  return el as T;
}

// The default server keeps the original key, so existing acknowledgments
// still count; each third-party server gets its own.
function turn_warning_storage_key(
  third_party_host: string | undefined,
): string {
  return third_party_host === undefined
    ? TURN_WARNING_STORAGE_KEY
    : `${TURN_WARNING_STORAGE_KEY}:${third_party_host}`;
}

// Returns an error message, or null if the name is acceptable.
function validate_device_name(device_name: string): string | null {
  if (device_name.length === 0) {
    return "enter a device name first";
  }
  if (device_name.length > MAX_DEVICE_NAME_LENGTH) {
    return `device name must be ${MAX_DEVICE_NAME_LENGTH} characters or fewer`;
  }
  return null;
}

function has_acknowledged_turn_warning(
  third_party_host: string | undefined,
): boolean {
  try {
    return (
      localStorage.getItem(turn_warning_storage_key(third_party_host)) !== null
    );
  } catch {
    // Storage access can throw (private browsing, disabled entirely) - if
    // we can't remember a prior acknowledgment, show the warning every
    // time rather than silently skipping a disclosure the user never
    // actually saw.
    return false;
  }
}

function mark_turn_warning_acknowledged(
  third_party_host: string | undefined,
): void {
  try {
    localStorage.setItem(turn_warning_storage_key(third_party_host), "1");
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
  const send_progress_el = require_element<HTMLElement>("send-progress");
  const send_progress_bar_el =
    require_element<HTMLElement>("send-progress-bar");
  const send_progress_file_el =
    require_element<HTMLElement>("send-progress-file");
  const send_progress_label_el = require_element<HTMLElement>(
    "send-progress-label",
  );
  const transfer_toast_el = require_element<HTMLElement>("transfer-toast");
  const transfer_toast_body_el = require_element<HTMLElement>(
    "transfer-toast-body",
  );
  // True while a transfer is sending or awaiting confirmation.
  let send_locked = false;
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
  const turn_warning_third_party_el = require_element<HTMLElement>(
    "turn-warning-third-party",
  );
  const turn_warning_third_party_host_el = require_element<HTMLElement>(
    "turn-warning-third-party-host",
  );
  const signaling_notice_el = require_element<HTMLElement>("signaling-notice");
  const signaling_notice_host_el = require_element<HTMLElement>(
    "signaling-notice-host",
  );
  const signaling_tamper_el = require_element<HTMLElement>("signaling-tamper");
  const signaling_tamper_peer_el = require_element<HTMLElement>(
    "signaling-tamper-peer",
  );
  const join_guide_modal_el = require_element<HTMLElement>("join-guide-modal");
  const join_guide_modal = new window.bootstrap.Modal(join_guide_modal_el);
  const join_guide_form = require_element<HTMLFormElement>("join-guide-form");
  const join_guide_room_el = require_element<HTMLElement>("join-guide-room");
  const join_guide_name_input =
    require_element<HTMLInputElement>("join-guide-name");
  const join_guide_error_el = require_element<HTMLElement>("join-guide-error");
  const join_guide_submit_button =
    require_element<HTMLButtonElement>("join-guide-submit");
  const join_guide_third_party_el = require_element<HTMLElement>(
    "join-guide-third-party",
  );
  const join_guide_host_el = require_element<HTMLElement>("join-guide-host");
  const send_tab_el = require_element<HTMLElement>("send-tab");
  // True from the guide's submit until index.mts reports how the join went.
  let join_guide_in_flight = false;
  // Set on submit, so the modal's "hidden" handler knows to continue into
  // the join rather than treat the close as a dismissal.
  let join_guide_submitted = false;
  // Bootstrap ignores hide() while a modal is still fading in, so a fast
  // submit (or autofill + Enter) during that window is held until "shown".
  let join_guide_fully_shown = false;
  // Host of the third-party signaling server currently in use, or
  // undefined for the default one - see set_third_party_signaling_url.
  let third_party_signaling_host: string | undefined;

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
      turn_warning_third_party_host_el.textContent =
        third_party_signaling_host ?? "";
      turn_warning_third_party_el.classList.toggle(
        "d-none",
        third_party_signaling_host === undefined,
      );
      turn_warning_modal.show();
    });
  }

  // Shared by the join button's click listener and trigger_join() - both
  // must go through the identical validation/consent flow, reading
  // straight from the DOM inputs rather than accepting parameters, so
  // there's exactly one place this logic exists.
  //
  // Resolves true if the join message was sent, false if validation, the
  // TURN consent, or on_join itself stopped it.
  async function attempt_join(): Promise<boolean> {
    const device_name = device_name_input.value.trim();
    const name_error = validate_device_name(device_name);
    if (name_error !== null) {
      ui_log(name_error);
      return false;
    }
    const room_code = room_code_input.value.trim() || undefined;
    const is_turn = use_turn_checkbox.checked;

    // Captured before the modal, so the acknowledgment is recorded against
    // the server the user was actually shown.
    const host = third_party_signaling_host;
    if (is_turn && !has_acknowledged_turn_warning(host)) {
      const accepted = await show_turn_warning_modal();
      if (!accepted) {
        ui_log("TURN relay declined - join not sent");
        return false;
      }
      mark_turn_warning_acknowledged(host);
      ui_log("TURN relay use acknowledged");
    }

    return callbacks.on_join(device_name, room_code, is_turn);
  }

  function set_join_guide_error(message: string | null): void {
    join_guide_error_el.textContent = message ?? "";
    join_guide_name_input.classList.toggle("is-invalid", message !== null);
  }

  // The pulse only starts once there's a name to submit, so the eye goes
  // to the empty field first and the button second.
  function update_join_guide_pulse(): void {
    join_guide_submit_button.classList.toggle(
      "join-guide-pulse",
      join_guide_name_input.value.trim().length > 0,
    );
  }

  function open_join_guide(room_code: string): void {
    join_guide_room_el.textContent = room_code;
    join_guide_name_input.value = device_name_input.value.trim();
    join_guide_host_el.textContent = third_party_signaling_host ?? "";
    join_guide_third_party_el.classList.toggle(
      "d-none",
      third_party_signaling_host === undefined,
    );
    set_join_guide_error(null);
    update_join_guide_pulse();
    join_guide_modal.show();
  }

  join_guide_name_input.addEventListener("input", () => {
    set_join_guide_error(null);
    update_join_guide_pulse();
  });

  join_guide_form.addEventListener("submit", (event) => {
    event.preventDefault();
    const device_name = join_guide_name_input.value.trim();
    const name_error = validate_device_name(device_name);
    if (name_error !== null) {
      set_join_guide_error(name_error);
      join_guide_name_input.focus();
      return;
    }
    device_name_input.value = device_name;
    join_guide_submitted = true;
    if (join_guide_fully_shown) {
      join_guide_modal.hide();
    }
  });

  join_guide_modal_el.addEventListener("shown.bs.modal", () => {
    join_guide_fully_shown = true;
    if (join_guide_submitted) {
      join_guide_modal.hide();
      return;
    }
    join_guide_name_input.focus();
    join_guide_name_input.select();
  });

  // Continues into the join only once the modal has fully closed - the
  // TURN consent modal may open next, and Bootstrap doesn't handle one
  // modal opening while another is still animating shut.
  join_guide_modal_el.addEventListener("hidden.bs.modal", () => {
    join_guide_fully_shown = false;
    if (!join_guide_submitted) {
      // Dismissed - the form is still prefilled, so the user can carry on
      // from the Connect tab by hand.
      return;
    }
    join_guide_submitted = false;
    join_guide_in_flight = true;
    void attempt_join().then((sent) => {
      if (!sent) {
        join_guide_in_flight = false;
      }
    });
  });

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

  const SEND_BAR_STATE_CLASSES = [
    "progress-bar-striped",
    "progress-bar-animated",
    "send-progress-active",
    "bg-success",
    "bg-danger",
  ];

  function render_send_bar(
    percent: number,
    classes: string[],
    label: string,
  ): void {
    send_progress_bar_el.classList.remove(...SEND_BAR_STATE_CLASSES);
    send_progress_bar_el.classList.add(...classes);
    send_progress_bar_el.style.width = `${percent}%`;
    send_progress_el.setAttribute("aria-valuenow", String(percent));
    // Silenced while sending, or a screen reader would read out every
    // percent; the outcome is announced by the toast, and messages like
    // "Choose a file first" are still read out.
    send_progress_label_el.setAttribute(
      "aria-live",
      classes.includes("progress-bar-animated") ? "off" : "polite",
    );
    send_progress_label_el.textContent = label;
  }

  function set_send_locked(locked: boolean): void {
    send_locked = locked;
    send_file_button.disabled = locked;
    file_input.disabled = locked;
    dropzone_el.classList.toggle("opacity-50", locked);
    // aria-disabled also drives the index.html rule that makes the locked
    // dropzone ignore the pointer (and so its hover styling).
    dropzone_el.setAttribute("aria-disabled", String(locked));
    dropzone_el.tabIndex = locked ? -1 : 0;
  }

  // A newly chosen file resets the bar to empty and puts its name at the
  // end of it.
  function select_file(file: File | undefined): void {
    show_dropped_file(file);
    send_progress_file_el.textContent = file?.name ?? "No file selected";
    send_progress_file_el.title = file?.name ?? "";
    render_send_bar(0, [], "");
  }

  function set_send_state(state: SendState): void {
    switch (state.kind) {
      case "idle":
        set_send_locked(false);
        render_send_bar(0, [], "");
        break;
      case "sending": {
        set_send_locked(true);
        const percent = Math.max(0, Math.min(100, Math.round(state.percent)));
        render_send_bar(
          percent,
          [
            "progress-bar-striped",
            "progress-bar-animated",
            "send-progress-active",
          ],
          `Sending... ${percent}%`,
        );
        break;
      }
      case "confirming":
        set_send_locked(true);
        render_send_bar(
          100,
          [
            "progress-bar-striped",
            "progress-bar-animated",
            "send-progress-active",
          ],
          "Waiting for the other device to confirm...",
        );
        break;
      case "delivered":
      case "failed":
        set_send_locked(false);
        if (state.kind === "delivered") {
          render_send_bar(
            100,
            ["bg-success"],
            `Delivered to ${state.recipient} - checked and intact`,
          );
        } else {
          render_send_bar(100, ["bg-danger"], `Failed: ${state.reason}`);
        }
        // Cleared so choosing the same file again still counts as a new
        // selection (a file input doesn't fire "change" for an unchanged
        // value). The bar keeps the finished file's name and colour until
        // then.
        file_input.value = "";
        show_dropped_file(undefined);
        break;
    }
  }

  function show_toast(variant: ToastVariant, message: string): void {
    transfer_toast_el.classList.remove("text-bg-success", "text-bg-danger");
    transfer_toast_el.classList.add(`text-bg-${variant}`);
    // Failures interrupt a screen reader; successes wait their turn.
    transfer_toast_el.setAttribute(
      "role",
      variant === "danger" ? "alert" : "status",
    );
    transfer_toast_el.setAttribute(
      "aria-live",
      variant === "danger" ? "assertive" : "polite",
    );
    transfer_toast_body_el.textContent = message;
    window.bootstrap.Toast.getOrCreateInstance(transfer_toast_el, {
      delay: 5000,
    }).show();
  }

  // A file dropped anywhere the dropzone doesn't handle - elsewhere on the
  // page, or on the dropzone itself while it's locked and ignoring the
  // pointer - would otherwise be opened by the browser in place of hopdrop,
  // ending any transfer in progress.
  // Files only, so dragging text into the name or room code box still works.
  const ignore_stray_file_drop = (event: DragEvent): void => {
    if (event.dataTransfer?.types.includes("Files") === true) {
      event.preventDefault();
    }
  };
  window.addEventListener("dragover", ignore_stray_file_drop);
  window.addEventListener("drop", ignore_stray_file_drop);

  dropzone_el.addEventListener("click", () => {
    if (send_locked) {
      return;
    }
    file_input.click();
  });
  dropzone_el.addEventListener("keydown", (event) => {
    if (send_locked) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      file_input.click();
    }
  });
  file_input.addEventListener("change", () => {
    select_file(file_input.files?.[0]);
  });
  dropzone_el.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (send_locked) {
      return;
    }
    dropzone_el.classList.add("border-accent-subtle", "bg-accent-2-subtle");
  });
  dropzone_el.addEventListener("dragleave", () => {
    dropzone_el.classList.remove("border-accent-subtle", "bg-accent-2-subtle");
  });
  dropzone_el.addEventListener("drop", (event) => {
    event.preventDefault();
    dropzone_el.classList.remove("border-accent-subtle", "bg-accent-2-subtle");
    if (send_locked) {
      return;
    }
    const data_transfer = event.dataTransfer;
    const dropped_file = data_transfer?.files?.[0];
    if (data_transfer === null || dropped_file === undefined) {
      return;
    }
    file_input.files = data_transfer.files;
    select_file(dropped_file);
  });

  send_file_button.addEventListener("click", () => {
    const device_id = peer_select.value;
    const file = file_input.files?.[0];
    if (device_id === "") {
      ui_log("select a peer first");
      send_progress_label_el.textContent = "Choose a recipient first";
      return;
    }
    if (file === undefined) {
      ui_log("choose a file first");
      send_progress_label_el.textContent = "Choose a file first";
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
        opt.textContent = peer.verified
          ? peer.device_name
          : `${peer.device_name} (unverified)`;
        if (!peer.verified) {
          opt.title =
            "Connected using a typed room code, so the signaling server could have tampered with this connection. Join via the QR code or link for a verified one.";
        }
        peer_select.appendChild(opt);
      }
    },

    set_send_state,

    show_toast,

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

    get_default_signaling_url() {
      return ws_url_input.defaultValue;
    },

    prefill_signaling_url(url) {
      ws_url_input.value = url;
    },

    set_third_party_signaling_url(url) {
      if (url === undefined) {
        third_party_signaling_host = undefined;
        signaling_notice_el.classList.add("d-none");
        return;
      }
      let host: string;
      try {
        host = new URL(url).host;
      } catch {
        host = url;
      }
      third_party_signaling_host = host;
      signaling_notice_host_el.textContent = host;
      signaling_notice_el.classList.remove("d-none");
    },

    show_signaling_tamper_warning(peer_name) {
      signaling_tamper_peer_el.textContent = peer_name;
      signaling_tamper_el.classList.remove("d-none");
    },

    clear_signaling_tamper_warning() {
      signaling_tamper_peer_el.textContent = "";
      signaling_tamper_el.classList.add("d-none");
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

    show_join_guide: open_join_guide,

    report_join_guide_result(error_message) {
      if (!join_guide_in_flight) {
        return;
      }
      join_guide_in_flight = false;
      if (error_message === undefined) {
        return;
      }
      open_join_guide(room_code_input.value.trim());
      set_join_guide_error(error_message);
    },

    show_send_tab() {
      window.bootstrap.Tab.getOrCreateInstance(send_tab_el).show();
    },
  };
}
