import { is_heartbeat_event } from "/onebot/index.ts";
import { Event } from "/onebot/types/event/common.ts";
import { HeartbeatEvent } from "/onebot/types/event/meta.ts";
import { heartbeat_start } from "/utils.ts";
import { setup_ws_api, setup_ws_event, WS_EVENT } from "/ws.ts";
import { HeartbeatEventHandler } from "/handlers/meta_event/heartbeat/types.ts";
import { get_config } from "/config.ts";

const handle_func = (event: HeartbeatEvent) => {
  const beat = heartbeat_start(event.interval, () => {
    setup_ws_event();
    if (!get_config().http_api_call) setup_ws_api();
  });
  const listener = (msg: MessageEvent) => {
    const event: Event = JSON.parse(msg.data);
    if (is_heartbeat_event(event)) {
      beat();
      WS_EVENT.removeEventListener("message", listener);
    }
  };
  WS_EVENT.addEventListener("message", listener);
};

export default new HeartbeatEventHandler({
  name: "reconnect",
  handle_func,
});
