# Using the bot in a group

*[한국어](group-setup.ko.md)*

A DM is enough to get work done, but a group gives you **one room per topic** — each topic has its own
session, its own queue, and runs in parallel, so you can keep several things going at once and open a
fresh one with `/newchat` whenever you need to. The cost: **everyone in that room can command the bot**.
Read [Security](#security) before you invite anyone.

---

## Before you start

This assumes the bot already works in a DM. If it doesn't, do the
[README quick start](../README.md) first.

---

## 1. Turn off privacy mode in BotFather

**Skip this and the bot won't hear most of what you say in the group.**

Telegram bots ship with *privacy mode* **on**. In that state, the only things forwarded to a bot in a
group are:

- messages starting with `/`
- messages that `@mention` the bot
- replies to the bot's own messages

So plain `run the tests` **never reaches the bot at all**. It looks broken, and nothing shows up in the
logs either — Telegram simply never delivered it.

In [@BotFather](https://t.me/BotFather):

```
/setprivacy → pick your bot → Disable
```

You want `Success! The new status is: DISABLED.`

> **If the bot is already in the group, remove it and invite it again.** The privacy setting is baked in
> at join time, so changing it doesn't affect rooms the bot is already sitting in.

**Alternative:** leave privacy on and make the bot a **group admin** instead. An admin bot receives every
message regardless of the privacy setting. If you plan to use Topics you need admin rights anyway, so
this may be the simpler path.

---

## 2. Create the group and invite the bot

1. Create a new group in Telegram (a group of one is fine).
2. Add the bot as a member.
3. If you want Topics — group info → Edit → turn on **Topics**.
4. Promote the bot to **admin** and grant **Manage topics**. `/newchat` needs it.

> **Turning on Topics changes the chat ID.** Enabling Topics upgrades a basic group to a supergroup, and
> Telegram issues it a **new ID** starting with `-100…`. The bot follows that migration automatically
> (sessions come along) and tells you to update `allowedChatId` — but only for a room that was **already
> allowed**. Cleanest order: turn Topics on *first*, then do step 3.

---

## 3. Take the chat ID the bot hands you and put it in `allowedChatId`

The moment it's invited, the bot posts this in the room:

> 👋 I'm in this chat, but it isn't on the allow list — until it is, I ignore everything said here.
>
> This chat's ID:
> `-1001234567890`

If you don't see it, say anything in the room (use a command like `/id` if privacy mode is still on) and
the same notice arrives. It's sent **once per chat**, so restart the bot if you need it again.

Put the ID in your config file. `allowedChatId` takes either a single string or an array:

```json
{
  "allowedChatId": ["123456789", "-1001234567890"]
}
```

First is your existing DM, second is the new group. **Restart the bot** for it to take effect
(`/restart`, or restart the daemon).

> **Topics don't need registering.** The allow list works on chat IDs, so allowing the group opens every
> topic inside it. Only the sessions are split per topic.

---

## 4. Check it

In the group:

```
/status
```

A version and a status line means you're done. Now split the work across topics:

| Command | What it does |
| --- | --- |
| `/newchat [name]` | Open a new topic and start a fresh session there (`/newtopic` works too) |
| `/new` | Reset only the current room's session |
| `/id` | Show this room's chat ID (and topic ID) |
| `/sessions` | List past sessions and pick one to carry on from |

---

## Security

**The allow list is per *room*, not per person.** Allowing a group lets everyone in it run Claude in your
project through the bot — editing files and running commands included. Inviting someone to that group is
the same as handing them the bot.

- Use a dedicated **private group** and don't circulate the invite link.
- Lock the group so only admins can add people.
- If you think the bot token leaked, revoke it immediately with `/revoke` in
  [@BotFather](https://t.me/BotFather).
- If a stranger drags your bot into their own group, the bot posts the notice above and does nothing
  else — that room isn't in `allowedChatId`, so nothing runs.

---

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Bot is silent in the group | Privacy mode — messages never reach the bot | BotFather `/setprivacy` → Disable, **then re-invite**, or make the bot an admin |
| Commands (`/status`) work but plain messages don't | Same cause (privacy lets commands through) | Same as above |
| No notice after inviting it | The bot already greeted this room once | Restart the bot, then `/id` |
| Worked, then started ignoring everything | Enabling Topics upgraded the group → new chat ID | The bot tells you the new ID; update `allowedChatId` and restart |
| `/newchat` fails | Topics are off, or the bot lacks *Manage topics* | Turn on Topics in group settings and grant the permission |
| Another bot answers your commands | Several bots in one room | Address yours: `/status@YourBotName` |

---

## See also

- [README](../README.md) — every config key and how the bot behaves day to day
- [CHANGELOG](../CHANGELOG.md)
