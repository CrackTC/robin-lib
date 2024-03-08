import Cron from "https://deno.land/x/croner@8.0.0/src/croner.js";
import db from "/db.ts";
import { mk_image, mk_text, send_group_message } from "/onebot/index.ts";
import { GroupMessageEvent } from "/onebot/types/event/message.ts";
import { backup, error } from "/utils.ts";
import { rate_limit, task_queue, wrap } from "/wrappers.ts";
import { HandlerConfig } from "/handlers/common.ts";
import { get_group_event_handler } from "/handlers/message/group/index.ts";
import { GroupEventHandler } from "/handlers/message/group/types.ts";
import { encode } from "https://deno.land/std@0.202.0/encoding/base64.ts";

const NAME = "word_cloud";
const config = new HandlerConfig(NAME, {
  cron: "0 0 0 * * *",
  filter_regex: [] as string[],
  api_address: "",
  cloud_options: {
    background_image: undefined as string | undefined,
    text: "",
  },
  background_image_path: undefined as string | undefined,
});

db.execute(`
  CREATE TABLE IF NOT EXISTS ${NAME} (
    group_id INTEGER NOT NULL,
    message TEXT NOT NULL
  )
`);

const insert = (group_id: number, message: string) =>
  db.query(
    `INSERT INTO ${NAME} (group_id, message) VALUES (?, ?)`,
    [group_id, message],
  );

const get_group_messages = (group_id: number) =>
  db.query<[string]>(
    `SELECT message FROM ${NAME} WHERE group_id = ?`,
    [group_id],
  ).map((row) => row[0]);

const clear_group = (group_id: number) =>
  db.query(
    `DELETE FROM ${NAME} WHERE group_id = ?`,
    [group_id],
  );

const handle_func = (event: GroupMessageEvent) => {
  const group_id = event.group_id;
  let message;
  if (typeof event.message === "string") {
    message = event.message;
  } else {
    message = event.message.map((seg) =>
      seg.type == "text" ? seg.data.text : ""
    ).join(" ");
  }

  if (message.trim() == "/wordcloud") send_queued(group_id);
  insert(group_id, message);
};

const filter = (message: string) => {
  config.value.filter_regex.forEach((regstr) => {
    const reg = new RegExp(regstr, "g");
    message = message.replaceAll(reg, "");
  });
  return message;
};

const send_word_cloud = async (group_id: number) => {
  const messages = get_group_messages(group_id);
  if (messages.length === 0) return;

  config.value.cloud_options.text = filter(messages.join("\n"));
  const resp = await fetch(config.value.api_address, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config.value.cloud_options),
  });

  if (!resp.ok) {
    error("word cloud api request failed");
    return;
  }

  const image = new Uint8Array(await resp.arrayBuffer());

  const success = await send_group_message(group_id, [mk_image(image)]);
  if (!success) {
    error("send image failed");
    backup(image, `${NAME}.png`);
  }
};

let job: Cron;

const send_queued =
  wrap<(id: number) => Promise<void> | void>(send_word_cloud).with(rate_limit({
    get_id: (id) => id,
    get_limit: () => 1,
    get_period: () => 60 * 1000,
    exceed_action: (arg, wait_seconds) => {
      send_group_message(
        arg,
        [mk_text(`太快啦>_<，请等待 ${wait_seconds} 秒后再试`)],
      );
    },
  })).with(task_queue).call;

const word_cloud = new GroupEventHandler({
  name: NAME,
  handle_func,
  on_config_change: (new_config) => {
    config.on_config_change(new_config);
    const { background_image_path, cloud_options } = config.value;
    if (background_image_path) {
      const image = Deno.readFileSync(background_image_path);
      cloud_options.background_image = encode(image);
    }

    const info = get_group_event_handler(NAME);
    if (info === null) return;

    if (job !== undefined) job.stop();
    job = new Cron(config.value.cron, { name: NAME }, () => {
      if (info.enabled) {
        info.groups.forEach(async (id: number) => {
          await send_queued(id);
          clear_group(id);
        });
      }
    });
  },
});

export default word_cloud;
