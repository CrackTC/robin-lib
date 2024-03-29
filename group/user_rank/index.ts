import Cron from "https://deno.land/x/croner@8.0.0/src/croner.js";
import db from "/db.ts";
import {
  get_group_member_list,
  get_safe_card,
  mk_text,
  send_group_message,
} from "/onebot/index.ts";
import { GroupMessageEvent } from "/onebot/types/event/message.ts";
import { backup, error } from "/utils.ts";
import { HandlerConfig } from "/handlers/common.ts";
import { get_group_event_handler } from "/handlers/message/group/index.ts";
import { GroupEventHandler } from "/handlers/message/group/types.ts";
import { rate_limit, wrap } from "/wrappers.ts";

const NAME = "user_rank";
const config = new HandlerConfig(NAME, {
  cron: "0 0 0 * * *",
});

db.execute(`
  CREATE TABLE IF NOT EXISTS ${NAME} (
    group_id INTEGER NOT NULL,
    id INTEGER NOT NULL
  )
`);

const insert = (group_id: number, id: number) =>
  db.query(
    `INSERT INTO ${NAME} (group_id, id) VALUES (?, ?)`,
    [group_id, id],
  );

const get_top_n = (group_id: number, n: number) =>
  db.query<[number, number]>(
    `
    SELECT id, COUNT(*) AS count
    FROM (SELECT * FROM ${NAME} WHERE group_id = ?)
    GROUP BY id
    ORDER BY count DESC
    LIMIT ?`,
    [group_id, n],
  );

const get_people_count = (group_id: number) =>
  db.query<[number]>(
    `SELECT COUNT(DISTINCT id) FROM ${NAME} WHERE group_id = ?`,
    [group_id],
  )[0][0];

const get_msg_count = (group_id: number) =>
  db.query<[number]>(
    `SELECT COUNT(*) FROM ${NAME} WHERE group_id = ?`,
    [group_id],
  )[0][0];

const clear_group = (group_id: number) =>
  db.query(`DELETE FROM ${NAME} WHERE group_id = ?`, [group_id]);

const get_description_text = (
  peoples: number,
  messages: number,
  rank: [string, number][],
) =>
  `本群 ${peoples} 位朋友共产生 ${messages} 条发言\n` +
  "活跃用户排行榜" +
  rank.map(([name, count]) => `\n${name} 贡献: ${count}`);

const get_description = async (group_id: number) => {
  const people_count = get_people_count(group_id);
  if (people_count == 0) return "本群无人发言";

  const msg_count = get_msg_count(group_id);
  const rank = get_top_n(group_id, 10);

  const members = await get_group_member_list(group_id);
  if (!members) {
    error(`get group member list for ${group_id} failed`);
    return;
  }

  const dict: Record<number, string> = {};
  members.forEach((member) => {
    dict[member.user_id] = get_safe_card(member.card) ?? member.nickname;
  });

  return get_description_text(
    people_count,
    msg_count,
    rank.map(([id, count]) => [dict[id], count]),
  );
};

const handle_func = (event: GroupMessageEvent) => {
  const group_id = event.group_id;
  const id = event.sender.user_id;
  let message;
  if (typeof event.message === "string") {
    message = event.message;
  } else {
    message = event.message.map((seg) =>
      seg.type == "text" ? seg.data.text : ""
    ).join(" ");
  }

  if (message.trim() == "/rank") send_description(group_id);
  insert(group_id, id);
};

const send_description =
  wrap<(id: number) => Promise<void> | void>(async (group_id: number) => {
    const desc = await get_description(group_id);
    if (!desc) {
      error(`get description for ${group_id} failed`);
      return;
    }

    const success = await send_group_message(group_id, [mk_text(desc)]);
    if (!success) {
      error("send description failed");
      backup(desc, `${NAME}.txt`);
    }
  }).with(rate_limit({
    get_id: (id) => id,
    get_limit: () => 1,
    get_period: () => 60 * 1000,
    exceed_action: (arg, wait_seconds) => {
      send_group_message(
        arg,
        [mk_text(`太快啦>_<，请等待 ${wait_seconds} 秒后再试`)],
      );
    },
  })).call;

let job: Cron;

export default new GroupEventHandler({
  name: NAME,
  handle_func,
  on_config_change: (new_config) => {
    config.on_config_change(new_config);
    const info = get_group_event_handler(NAME);
    if (info === null) return;

    if (job !== undefined) job.stop();
    job = new Cron(config.value.cron, { name: NAME }, () => {
      if (info.enabled) {
        info.groups.forEach(async (id: number) => {
          await send_description(id);
          clear_group(id);
        });
      }
    });
  },
});
