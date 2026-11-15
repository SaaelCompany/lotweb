import http from "node:http";
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import pg from "pg";
import nodemailer from "nodemailer";
import QRCode from "qrcode";

const PORT = Number(process.env.PORT || 3000);
const databaseUrl = process.env.DATABASE_URL?.trim() ?? "";
const DAY = 86400000;
const SESSION = "lot_session";
const PLAN_RE = /^[a-z0-9]{1,32}$/;
const ID_RE = /^[a-f0-9]{32}$/;

const globalDb = globalThis;
const state = (globalDb.__lotDb ??= {});
const panelMemory = globalThis;

const SCHEMA = [
  `create table if not exists users (
    id text primary key,
    email text not null unique,
    created_at timestamptz not null default now()
  )`,
  `create table if not exists login_codes (
    id text primary key,
    email text not null,
    code_hash text not null,
    token_hash text not null,
    next_path text not null default '/cabinet',
    expires_at timestamptz not null,
    attempts integer not null default 0,
    used_at timestamptz,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists login_codes_email_idx on login_codes (email)`,
  `create table if not exists sessions (
    id text primary key,
    user_id text not null references users (id),
    token_hash text not null unique,
    expires_at timestamptz not null,
    created_at timestamptz not null default now()
  )`,
  `create table if not exists plans (
    id text primary key,
    title text not null,
    days integer not null,
    price_rub integer not null,
    traffic_gb integer not null default 0,
    sort integer not null,
    active boolean not null default true
  )`,
  `create table if not exists vpn_keys (
    id text primary key,
    user_id text not null references users (id),
    label text not null,
    client_email text not null unique,
    client_uuid text not null,
    sub_id text not null,
    inbound_id integer,
    expires_at timestamptz not null,
    traffic_gb integer not null default 0,
    subscription_url text not null,
    share_link text not null default '',
    demo boolean not null default false,
    panel_api text not null default 'demo',
    created_at timestamptz not null default now()
  )`,
  `create index if not exists vpn_keys_user_idx on vpn_keys (user_id)`,
  `create sequence if not exists order_inv_seq start with 1000`,
  `create table if not exists orders (
    id text primary key,
    inv_id bigint not null unique,
    user_id text not null references users (id),
    plan_id text not null references plans (id),
    key_id text references vpn_keys (id),
    kind text not null,
    amount_rub integer not null,
    status text not null,
    demo boolean not null default false,
    last_error text,
    claim_until timestamptz,
    extend_until_ms bigint,
    created_at timestamptz not null default now(),
    paid_at timestamptz,
    constraint orders_kind_check check (kind in ('new', 'renew')),
    constraint orders_status_check check (status in ('pending', 'paid'))
  )`,
  `create index if not exists orders_user_idx on orders (user_id)`,
  `create table if not exists login_limits (
    id bigserial primary key,
    bucket text not null,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists login_limits_bucket_idx on login_limits (bucket, created_at)`,
  `insert into plans (id, title, days, price_rub, traffic_gb, sort)
   values ('m1', '30 дней', 30, 249, 0, 1), ('m3', '90 дней', 90, 599, 0, 2), ('m6', '180 дней', 180, 999, 0, 3)
   on conflict (id) do nothing`,
];

function env(name) {
  return process.env[name]?.trim() ?? "";
}

function robokassaConfigured() {
  return Boolean(env("ROBOKASSA_MERCHANT_LOGIN") && env("ROBOKASSA_PASSWORD1") && env("ROBOKASSA_PASSWORD2"));
}

function inboundIds() {
  return env("XUI_INBOUND_ID").split(",").map((part) => Number(part.trim())).filter((value) => Number.isInteger(value) && value > 0);
}

function xuiConfigured() {
  return Boolean(env("XUI_BASE_URL") && (env("XUI_API_TOKEN") || (env("XUI_USERNAME") && env("XUI_PASSWORD"))) && inboundIds().length);
}

function mailConfigured() {
  return Boolean(env("SMTP_HOST") && env("SMTP_FROM"));
}

function liveCheckout() {
  return robokassaConfigured() && xuiConfigured();
}

function hashName() {
  const value = env("ROBOKASSA_HASH").toLowerCase();
  return value === "sha256" || value === "sha384" || value === "sha512" || value === "md5" ? value : "md5";
}

function xuiFlow() {
  if (process.env.XUI_FLOW === undefined) return "xtls-rprx-vision";
  if (process.env.XUI_FLOW === "none") return "";
  return process.env.XUI_FLOW.trim();
}

function subscriptionBase() {
  const explicit = env("XUI_SUB_BASE_URL").replace(/\/$/, "");
  if (explicit) return explicit;
  const panel = env("XUI_BASE_URL").replace(/\/$/, "");
  return panel ? `${panel}/sub` : "";
}

async function sql(text, params = []) {
  if (databaseUrl !== "") {
    state.pool ??= new pg.Pool({ connectionString: databaseUrl, max: 5 });
    return (await state.pool.query(text, params)).rows;
  }
  const db = await localDb();
  return (await db.query(text, params)).rows;
}

async function transaction(fn) {
  if (databaseUrl !== "") {
    state.pool ??= new pg.Pool({ connectionString: databaseUrl, max: 5 });
    const client = await state.pool.connect();
    try {
      await client.query("begin");
      const result = await fn(async (text, params = []) => (await client.query(text, params)).rows);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  const db = await localDb();
  await db.exec("begin");
  try {
    const result = await fn(async (text, params = []) => (await db.query(text, params)).rows);
    await db.exec("commit");
    return result;
  } catch (error) {
    await db.exec("rollback");
    throw error;
  }
}

async function localDb() {
  state.local ??= startLocal().catch((error) => {
    state.local = undefined;
    throw error;
  });
  return state.local;
}

async function startLocal() {
  const db = new PGlite();
  for (const statement of SCHEMA) await db.exec(statement);
  return db;
}

async function applyPostgresSchema() {
  if (!databaseUrl) return;
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL_UNPOOLED?.trim() || databaseUrl });
  await client.connect();
  try {
    for (const statement of SCHEMA) await client.query(statement);
  } finally {
    await client.end();
  }
}

function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}

function sameHash(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function nid() {
  return randomBytes(16).toString("hex");
}

function normalizeEmail(value) {
  if (typeof value !== "string") return "";
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 254) return "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";
  return email;
}

function safeNext(value) {
  if (!value || typeof value !== "string" || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || value.includes("://") || value.includes("<") || value.includes(">")) {
    return "/cabinet";
  }
  try {
    const url = new URL(value, "http://local");
    if (url.origin !== "http://local") return "/cabinet";
    if (url.pathname === "/cabinet" || url.pathname.startsWith("/pay/")) return `${url.pathname}${url.search}`;
  } catch {
    return "/cabinet";
  }
  return "/cabinet";
}

function nextExpiry(currentMs, nowMs, days) {
  return Math.max(Number.isFinite(currentMs) ? currentMs : 0, nowMs) + days * DAY;
}

function nextQuotaBytes(currentBytes, addGb) {
  if (addGb <= 0) return 0;
  return (Number.isFinite(currentBytes) ? currentBytes : 0) + addGb * 1024 * 1024 * 1024;
}

function formatOutSum(rubles) {
  if (!Number.isInteger(rubles) || rubles <= 0 || rubles > 1_000_000) throw new Error("bad amount");
  return `${rubles}.00`;
}

function digest(value, algorithm) {
  return createHash(algorithm).update(value).digest("hex").toUpperCase();
}

function appendShp(chunks, shp) {
  for (const key of Object.keys(shp).sort()) chunks.push(`Shp_${key}=${shp[key]}`);
}

function paymentSignature({ login, outSum, invId, password, algorithm, shp }) {
  const chunks = [login, outSum, invId, password];
  appendShp(chunks, shp);
  return digest(chunks.join(":"), algorithm);
}

function resultSignature({ outSum, invId, password, algorithm, shp }) {
  const chunks = [outSum, invId, password];
  appendShp(chunks, shp);
  return digest(chunks.join(":"), algorithm);
}

function signaturesMatch(expected, received) {
  return sameHash(expected.toUpperCase(), String(received || "").toUpperCase());
}

function amountsMatch(paid, expectedRubles) {
  const value = Number(paid);
  return Number.isFinite(value) && Math.abs(value - expectedRubles) < 0.001;
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

function formatRub(value) {
  return new Intl.NumberFormat("ru-RU", { style: "currency", currency: "RUB", maximumFractionDigits: 0 }).format(value);
}

function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", year: "numeric" }).format(date);
}

function truthy(value) {
  return value === true || value === "t" || value === "true" || value === 1;
}

function toIso(value) {
  if (value instanceof Date) return value.toISOString();
  const date = new Date(String(value));
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

async function sendMail(to, subject, text, html) {
  if (!mailConfigured()) throw new Error("mail is not configured");
  const port = Number(process.env.SMTP_PORT || 587);
  const user = env("SMTP_USER");
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    auth: user ? { user, pass: process.env.SMTP_PASS ?? "" } : undefined,
  });
  await transporter.sendMail({ from: process.env.SMTP_FROM, to, subject, text, html });
}

async function requestLogin({ emailRaw, next, origin, ip }) {
  const email = normalizeEmail(emailRaw);
  if (!email) return { error: "Введите почту целиком, например name@mail.ru", status: 400 };
  if (await limited(email, ip)) return { error: "Слишком много писем. Попробуйте через 15 минут.", status: 429 };
  if (liveCheckout() && !mailConfigured()) {
    return { error: "Вход по почте ещё не подключён. Нужен SMTP, иначе код нельзя отправить.", status: 503 };
  }
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const token = randomBytes(32).toString("base64url");
  const id = nid();
  const nextPath = safeNext(next);
  await sql("delete from login_codes where email = $1 and used_at is null", [email]);
  await sql(
    `insert into login_codes (id, email, code_hash, token_hash, next_path, expires_at) values ($1,$2,$3,$4,$5,$6)`,
    [id, email, sha(`${email}:${code}`), sha(token), nextPath, new Date(Date.now() + 15 * 60 * 1000).toISOString()],
  );
  const link = `${origin}/auth/verify?token=${encodeURIComponent(token)}`;
  if (mailConfigured()) {
    try {
      await sendMail(
        email,
        "Код для входа в Лот",
        `Вход в Лот\n\nКод: ${code}\nОн действует 15 минут.\n\nИли откройте ссылку: ${link}\n\nЕсли вы не запрашивали вход, это письмо можно не читать.`,
        `<p>Код для входа: <strong>${esc(code)}</strong></p><p>Он действует 15 минут.</p><p><a href="${esc(link)}">Войти в кабинет</a></p>`,
      );
    } catch {
      await sql("update login_codes set used_at = now() where id = $1", [id]);
      return { error: "Письмо не отправилось. Проверьте почтовый сервер и попробуйте ещё раз.", status: 502 };
    }
    return { ok: true, delivery: "email" };
  }
  return { ok: true, delivery: "screen", code, link };
}

async function limited(email, ip) {
  await sql("delete from login_limits where created_at < now() - interval '1 hour'");
  const count = async (bucket) => Number((await sql("select count(*)::text as count from login_limits where bucket = $1 and created_at > now() - interval '15 minutes'", [bucket]))[0]?.count ?? 0);
  if ((await count(`email:${email}`)) >= 5 || (await count(`ip:${ip}`)) >= 20) return true;
  await sql("insert into login_limits (bucket) values ($1), ($2)", [`email:${email}`, `ip:${ip}`]);
  return false;
}

async function openSession(email, nextPath) {
  const existing = await sql("select id from users where email = $1", [email]);
  const userId = existing[0]?.id ?? nid();
  if (!existing[0]) await sql("insert into users (id, email) values ($1, $2)", [userId, email]);
  const sessionToken = randomBytes(32).toString("base64url");
  await sql("insert into sessions (id, user_id, token_hash, expires_at) values ($1,$2,$3,$4)", [
    nid(),
    userId,
    sha(sessionToken),
    new Date(Date.now() + 30 * DAY).toISOString(),
  ]);
  return { sessionToken, nextPath: safeNext(nextPath), user: { id: userId, email } };
}

async function verifyCode(emailRaw, codeRaw) {
  const email = normalizeEmail(emailRaw);
  const code = String(codeRaw || "").replace(/\D/g, "");
  if (!email || code.length !== 6) return null;
  const rows = await sql(
    `select id, code_hash, next_path, attempts from login_codes
     where email = $1 and used_at is null and expires_at > now() order by created_at desc limit 1`,
    [email],
  );
  const row = rows[0];
  if (!row || Number(row.attempts) >= 5) return null;
  if (!sameHash(row.code_hash, sha(`${email}:${code}`))) {
    await sql("update login_codes set attempts = attempts + 1 where id = $1", [row.id]);
    return null;
  }
  const consumed = await sql("update login_codes set used_at = now() where id = $1 and used_at is null returning id", [row.id]);
  if (!consumed[0]) return null;
  return openSession(email, row.next_path);
}

async function verifyMagic(token) {
  if (!token || token.length < 20 || token.length > 200) return null;
  const rows = await sql(
    "select id, email, next_path from login_codes where token_hash = $1 and used_at is null and expires_at > now() limit 1",
    [sha(token)],
  );
  const row = rows[0];
  if (!row) return null;
  const consumed = await sql("update login_codes set used_at = now() where id = $1 and used_at is null returning id", [row.id]);
  if (!consumed[0]) return null;
  return openSession(row.email, row.next_path);
}

async function currentUser(req) {
  const token = readCookies(req)[SESSION] || "";
  if (!token) return null;
  const rows = await sql(
    `select users.id, users.email from sessions join users on users.id = sessions.user_id
     where sessions.token_hash = $1 and sessions.expires_at > now() limit 1`,
    [sha(token)],
  );
  return rows[0] ?? null;
}

async function destroySession(req) {
  const token = readCookies(req)[SESSION] || "";
  if (token) await sql("delete from sessions where token_hash = $1", [sha(token)]);
}

function assertOk(result, fallback) {
  if (result.status >= 200 && result.status < 300 && result.json?.success !== false) return;
  const msg = typeof result.json?.msg === "string" ? result.json.msg.slice(0, 180) : "";
  throw new Error(msg || fallback);
}

function safeHttp(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return "";
    if (url.protocol !== "https:" && url.protocol !== "http:") return "";
    return url.toString();
  } catch {
    return "";
  }
}

function isShareLink(value) {
  return /^(vless|vmess|trojan|ss|hy2|hysteria2):\/\//.test(value) && !/[\s<>]/.test(value);
}

async function panel(path, init, retry = true) {
  const base = env("XUI_BASE_URL").replace(/\/$/, "");
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  if (init?.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const token = env("XUI_API_TOKEN");
  if (token) headers.set("authorization", `Bearer ${token}`);
  else headers.set("cookie", await panelCookie());
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${base}${path}`, { ...init, headers, cache: "no-store", redirect: "manual", signal: controller.signal });
    if ((response.status === 401 || response.status === 403 || response.status === 302) && retry && !token) {
      panelMemory.__lotXuiCookie = undefined;
      return panel(path, init, false);
    }
    const text = await response.text();
    let json = null;
    if (text) {
      try { json = JSON.parse(text); } catch { json = null; }
    }
    return { status: response.status, json };
  } finally {
    clearTimeout(timer);
  }
}

async function panelCookie() {
  const cached = panelMemory.__lotXuiCookie;
  if (cached && cached.until > Date.now()) return cached.value;
  const response = await fetch(`${env("XUI_BASE_URL").replace(/\/$/, "")}/login`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ username: process.env.XUI_USERNAME, password: process.env.XUI_PASSWORD }),
    cache: "no-store",
    redirect: "manual",
  });
  const pieces = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
  const value = pieces.map((cookie) => cookie.split(";")[0]).filter(Boolean).join("; ");
  if (!value || response.status >= 400) throw new Error("Панель 3x-ui не приняла вход");
  panelMemory.__lotXuiCookie = { value, until: Date.now() + 20 * 60 * 1000 };
  return value;
}

function present(client, email, inboundId, panelApi, shareLink) {
  const uuid = String(client.id || client.uuid || "");
  const subId = String(client.subId || "");
  const base = subscriptionBase();
  return {
    email,
    uuid,
    subId,
    expiresAtMs: Number(client.expiryTime) || 0,
    subscriptionUrl: safeHttp(base && subId ? `${base}/${encodeURIComponent(subId)}` : ""),
    shareLink: shareLink && isShareLink(shareLink) ? shareLink : "",
    inboundId,
    panelApi,
    comment: typeof client.comment === "string" ? client.comment : "",
    raw: client,
  };
}

async function findClient(email) {
  if (!xuiConfigured()) throw new Error("Панель 3x-ui не подключена");
  if (!panelMemory.__lotXuiLegacy) {
    const modern = await panel(`/panel/api/clients/get/${encodeURIComponent(email)}`);
    if (modern.status === 404) panelMemory.__lotXuiLegacy = true;
    else if (modern.status === 200 && modern.json?.success === true && modern.json.obj) {
      const obj = modern.json.obj;
      const client = obj.client ?? obj;
      if (!client || typeof client.email !== "string") return null;
      const links = Array.isArray(obj.externalLinks) ? obj.externalLinks : [];
      const share = links.find((item) => item && item.kind === "link" && typeof item.value === "string" && isShareLink(item.value));
      const inbound = Array.isArray(obj.inboundIds) ? Number(obj.inboundIds[0]) : inboundIds()[0];
      return present(client, email, Number.isInteger(inbound) ? inbound : null, "clients", share?.value);
    } else if (modern.json?.success === false) return null;
  }
  const inboundId = inboundIds()[0];
  const result = await panel(`/panel/api/inbounds/get/${inboundId}`);
  if (result.status === 404 || result.json?.success !== true) return null;
  const settingsRaw = result.json.obj?.settings;
  if (typeof settingsRaw !== "string") return null;
  let settings;
  try { settings = JSON.parse(settingsRaw); } catch { return null; }
  const client = settings.clients?.find((item) => item.email === email);
  return client ? present(client, email, inboundId, "inbounds") : null;
}

async function issueClient(input) {
  const existing = await findClient(input.email);
  if (existing) return existing;
  const flow = xuiFlow();
  const payload = {
    email: input.email,
    id: input.uuid,
    subId: input.subId,
    totalGB: input.totalBytes,
    expiryTime: input.expiryTime,
    limitIp: 0,
    tgId: 0,
    enable: true,
    comment: input.comment,
    ...(flow ? { flow } : {}),
  };
  if (!panelMemory.__lotXuiLegacy) {
    const modern = await panel("/panel/api/clients/add", {
      method: "POST",
      body: JSON.stringify({ client: payload, inboundIds: inboundIds() }),
    });
    if (modern.status !== 404) {
      assertOk(modern, "Не удалось создать ключ в панели");
      const created = await findClient(input.email);
      if (!created) throw new Error("Панель не вернула созданный ключ");
      return created;
    }
    panelMemory.__lotXuiLegacy = true;
  }
  const legacy = await panel("/panel/api/inbounds/addClient", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      id: String(inboundIds()[0]),
      settings: JSON.stringify({ clients: [{ ...payload, tgId: "", reset: 0 }] }),
    }).toString(),
  });
  assertOk(legacy, "Не удалось создать ключ в панели");
  const created = await findClient(input.email);
  if (!created) throw new Error("Панель не вернула созданный ключ");
  return created;
}

function editable(raw, overrides) {
  const body = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") body[key] = value;
  }
  return { ...body, ...overrides };
}

async function extendClientTo(input) {
  const current = await findClient(input.email);
  if (!current) throw new Error("Ключ не найден в панели");
  if (current.expiresAtMs + 5000 >= input.expiryTime) return current;
  const totalBytes = input.addGb <= 0 ? 0 : (Number(current.raw.totalGB) || 0) + input.addGb * 1024 * 1024 * 1024;
  const next = editable(current.raw, {
    id: current.uuid,
    email: input.email,
    subId: current.subId,
    expiryTime: input.expiryTime,
    totalGB: totalBytes,
    enable: true,
    comment: input.comment,
  });
  if (current.panelApi === "clients" && !panelMemory.__lotXuiLegacy) {
    const modern = await panel(`/panel/api/clients/update/${encodeURIComponent(input.email)}`, {
      method: "POST",
      body: JSON.stringify(next),
    });
    if (modern.status !== 404) {
      assertOk(modern, "Не удалось продлить ключ в панели");
      return (await findClient(input.email)) ?? { ...current, expiresAtMs: input.expiryTime };
    }
    panelMemory.__lotXuiLegacy = true;
  }
  const legacy = await panel(`/panel/api/inbounds/updateClient/${encodeURIComponent(current.uuid)}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      id: String(current.inboundId ?? inboundIds()[0]),
      settings: JSON.stringify({ clients: [next] }),
    }).toString(),
  });
  assertOk(legacy, "Не удалось продлить ключ в панели");
  return (await findClient(input.email)) ?? { ...current, expiresAtMs: input.expiryTime };
}

const ORDER_SELECT = `select orders.id, orders.inv_id::text, orders.user_id, orders.plan_id, orders.key_id, orders.kind,
  orders.amount_rub, orders.status, orders.demo, orders.last_error, orders.extend_until_ms::text,
  plans.title as plan_title, plans.days as plan_days
  from orders join plans on plans.id = orders.plan_id`;

function normalizeOrder(row) {
  return {
    ...row,
    inv_id: String(row.inv_id),
    amount_rub: Number(row.amount_rub),
    plan_days: Number(row.plan_days),
    kind: row.kind === "renew" ? "renew" : "new",
    status: row.status === "paid" ? "paid" : "pending",
    demo: truthy(row.demo),
  };
}

function normalizeKey(row) {
  return {
    ...row,
    expires_at: toIso(row.expires_at),
    created_at: toIso(row.created_at),
    demo: truthy(row.demo),
    traffic_gb: Number(row.traffic_gb),
  };
}

async function listPlans() {
  const rows = await sql("select id, title, days, price_rub, traffic_gb from plans where active = true order by sort, days");
  return rows.map((row) => ({ ...row, days: Number(row.days), price_rub: Number(row.price_rub), traffic_gb: Number(row.traffic_gb) }));
}

async function listKeys(userId) {
  const rows = await sql(
    "select id, label, expires_at, subscription_url, share_link, demo, traffic_gb, created_at from vpn_keys where user_id = $1 order by created_at",
    [userId],
  );
  return rows.map(normalizeKey);
}

async function createOrder({ userId, planId, kind, keyId }) {
  if (!PLAN_RE.test(planId)) return { error: "Такого тарифа нет", status: 400 };
  const plans = await sql("select id, title, days, price_rub, traffic_gb from plans where id = $1 and active = true", [planId]);
  const plan = plans[0];
  if (!plan) return { error: "Такого тарифа нет", status: 400 };
  let savedKey = null;
  if (kind === "renew") {
    if (!keyId || !ID_RE.test(keyId)) return { error: "Выберите ключ, который нужно продлить", status: 400 };
    const keys = await sql("select id from vpn_keys where id = $1 and user_id = $2", [keyId, userId]);
    if (!keys[0]) return { error: "Этот ключ вам не принадлежит", status: 404 };
    savedKey = keys[0].id;
  }
  const pending = await sql(
    "select count(*)::text as count from orders where user_id = $1 and status = 'pending' and created_at > now() - interval '1 day'",
    [userId],
  );
  if (Number(pending[0]?.count ?? 0) >= 8) return { error: "Слишком много неоплаченных счетов. Оплатите открытый или подождите.", status: 429 };
  const rows = await sql(
    `insert into orders (id, inv_id, user_id, plan_id, key_id, kind, amount_rub, status, demo)
     values ($1, nextval('order_inv_seq'), $2, $3, $4, $5, $6, 'pending', $7) returning id, inv_id::text`,
    [nid(), userId, plan.id, savedKey, kind, Number(plan.price_rub), !liveCheckout()],
  );
  return { ok: true, id: rows[0].id, demo: !liveCheckout() };
}

async function getOrderForUser(orderId, userId) {
  if (!ID_RE.test(orderId)) return null;
  const rows = await sql(`${ORDER_SELECT} where orders.id = $1 and orders.user_id = $2`, [orderId, userId]);
  if (!rows[0]) return null;
  const order = normalizeOrder(rows[0]);
  const key = order.key_id ? await keyById(order.key_id, userId) : null;
  return { order, key };
}

async function getOrderByInv(invId) {
  if (!/^\d{1,18}$/.test(String(invId))) return null;
  const rows = await sql(`${ORDER_SELECT} where orders.inv_id = $1`, [invId]);
  return rows[0] ? normalizeOrder(rows[0]) : null;
}

async function keyById(id, userId) {
  const rows = await sql(
    "select id, label, expires_at, subscription_url, share_link, demo, traffic_gb, created_at from vpn_keys where id = $1 and user_id = $2",
    [id, userId],
  );
  return rows[0] ? normalizeKey(rows[0]) : null;
}

async function loadKey(id, userId) {
  const rows = await sql(
    `select id, label, expires_at, subscription_url, share_link, traffic_gb, client_email, client_uuid, sub_id, panel_api, inbound_id
     from vpn_keys where id = $1 and user_id = $2`,
    [id, userId],
  );
  if (!rows[0]) return null;
  return { ...rows[0], expires_at: toIso(rows[0].expires_at), traffic_gb: Number(rows[0].traffic_gb) };
}

function requireLink(url) {
  if (!String(url || "").startsWith("https://") && !String(url || "").startsWith("http://")) {
    throw new Error("Панель не вернула ссылку подписки");
  }
}

async function rememberExpiry(order, currentMs, days) {
  if (order.extend_until_ms) return Number(order.extend_until_ms);
  const target = nextExpiry(currentMs, Date.now(), days);
  await sql("update orders set extend_until_ms = $2 where id = $1 and extend_until_ms is null", [order.id, target]);
  const rows = await sql("select extend_until_ms::text from orders where id = $1", [order.id]);
  return Number(rows[0]?.extend_until_ms ?? target);
}

function demoIssue(email, expiryTime) {
  const subId = randomBytes(8).toString("hex");
  return {
    email,
    uuid: randomUUID(),
    subId,
    expiresAtMs: expiryTime,
    subscriptionUrl: `https://demo.invalid/sub/${subId}`,
    shareLink: "",
    inboundId: null,
    panelApi: "demo",
  };
}

async function rememberError(invId, error) {
  const message = error instanceof Error ? error.message : "Ошибка выдачи";
  await sql("update orders set last_error = $2 where inv_id = $1 and status = 'pending'", [invId, message.replace(/\s+/g, " ").slice(0, 180)]);
}

async function fulfillDemo(orderId, userId) {
  if (liveCheckout()) return { error: "Демо-оплата выключена: подключена боевая Робокасса", status: 404 };
  const found = await getOrderForUser(orderId, userId);
  if (!found) return { error: "Счёт не найден", status: 404 };
  if (!found.order.demo) return { error: "Этот счёт нельзя оплатить в демо-режиме", status: 400 };
  if (found.order.status === "paid") return { ok: true };
  try {
    await provision(found.order.inv_id, true);
  } catch (error) {
    if (error instanceof Error && error.message === "Счёт уже обрабатывается") {
      return { error: "Счёт уже обрабатывается. Откройте кабинет через несколько секунд.", status: 409 };
    }
    await rememberError(found.order.inv_id, error);
    return { error: "Не удалось выдать ключ. Попробуйте ещё раз.", status: 502 };
  }
  return { ok: true };
}

async function fulfillPaid(invId) {
  if (!xuiConfigured()) {
    await rememberError(invId, new Error("Панель 3x-ui не подключена"));
    return "retry";
  }
  try {
    await provision(invId, false);
    return "ok";
  } catch (error) {
    await rememberError(invId, error);
    return "retry";
  }
}

async function provision(invId, demo) {
  const claimed = await sql(
    `update orders set claim_until = now() + interval '60 seconds'
     where inv_id = $1 and status = 'pending' and (claim_until is null or claim_until < now()) returning id`,
    [invId],
  );
  if (!claimed[0]) {
    const current = await getOrderByInv(invId);
    if (current?.status === "paid") return;
    throw new Error("Счёт уже обрабатывается");
  }
  try {
    const issued = await applyClaimed(invId, demo);
    if (issued && !issued.demo && mailConfigured() && issued.subscriptionUrl.startsWith("http")) {
      try {
        const verb = issued.renewed ? "Ключ продлён" : "Ключ готов";
        await sendMail(
          issued.email,
          verb,
          `${verb}\n\n${issued.label} действует до ${issued.expires}.\nСсылка подписки:\n${issued.subscriptionUrl}\n\nВставьте её в Hiddify, v2rayNG, Streisand или Nekobox.`,
          `<p>${esc(verb)}.</p><p>${esc(issued.label)} действует до ${esc(issued.expires)}.</p><p><a href="${esc(issued.subscriptionUrl)}">${esc(issued.subscriptionUrl)}</a></p>`,
        );
      } catch {
        // The key is already saved.
      }
    }
  } catch (error) {
    await sql("update orders set claim_until = null where inv_id = $1 and status = 'pending'", [invId]);
    throw error;
  }
}

async function applyClaimed(invId, demo) {
  const order = await getOrderByInv(invId);
  if (!order) throw new Error("order missing");
  if (order.status === "paid") return null;
  if (demo !== order.demo) throw new Error("order mode mismatch");
  const traffic = await sql("select traffic_gb from plans where id = $1", [order.plan_id]);
  const plan = { days: order.plan_days, trafficGb: Number(traffic[0]?.traffic_gb ?? 0) };
  const comment = `inv:${order.inv_id}`;
  if (order.kind === "renew") {
    if (!order.key_id) throw new Error("renew without key");
    const stored = await loadKey(order.key_id, order.user_id);
    if (!stored) throw new Error("key missing");
    const issued = demo ? await demoRenew(order, stored, plan.days) : await liveRenew(order, stored, plan, comment);
    requireLink(issued.subscriptionUrl);
    const email = await transaction(async (query) => {
      const status = await query("select status from orders where id = $1 for update", [order.id]);
      if (status[0]?.status === "paid") return "";
      await query(
        `update vpn_keys set expires_at = $2, traffic_gb = $3, subscription_url = $4, share_link = $5, demo = $6,
         panel_api = $7, client_uuid = $8, sub_id = $9, inbound_id = $10 where id = $1`,
        [
          stored.id,
          new Date(issued.expiresAtMs).toISOString(),
          plan.trafficGb === 0 ? 0 : Number(stored.traffic_gb) + plan.trafficGb,
          issued.subscriptionUrl,
          issued.shareLink || "",
          demo,
          issued.panelApi,
          issued.uuid || stored.client_uuid,
          issued.subId || stored.sub_id,
          issued.inboundId ?? null,
        ],
      );
      await query("update orders set status = 'paid', key_id = $2, paid_at = now(), last_error = null where id = $1", [order.id, stored.id]);
      const users = await query("select email from users where id = $1", [order.user_id]);
      return users[0]?.email ?? "";
    });
    return { email, label: stored.label, expires: formatDate(new Date(issued.expiresAtMs)), subscriptionUrl: issued.subscriptionUrl, renewed: true, demo };
  }
  const target = await rememberExpiry(order, 0, plan.days);
  const clientEmail = `lot${order.inv_id}`;
  const issued = demo
    ? demoIssue(clientEmail, target)
    : await issueClient({
        email: clientEmail,
        subId: randomBytes(8).toString("hex"),
        uuid: randomUUID(),
        expiryTime: target,
        totalBytes: nextQuotaBytes(0, plan.trafficGb),
        comment,
      });
  requireLink(issued.subscriptionUrl);
  const created = await transaction(async (query) => {
    const status = await query("select status from orders where id = $1 for update", [order.id]);
    if (status[0]?.status === "paid") return null;
    const count = await query("select count(*)::text as count from vpn_keys where user_id = $1", [order.user_id]);
    const label = `Ключ ${Number(count[0]?.count ?? 0) + 1}`;
    const keyId = nid();
    await query(
      `insert into vpn_keys
        (id, user_id, label, client_email, client_uuid, sub_id, inbound_id, expires_at, traffic_gb, subscription_url, share_link, demo, panel_api)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        keyId,
        order.user_id,
        label,
        issued.email,
        issued.uuid,
        issued.subId,
        issued.inboundId ?? null,
        new Date(issued.expiresAtMs || target).toISOString(),
        plan.trafficGb,
        issued.subscriptionUrl,
        issued.shareLink || "",
        demo,
        issued.panelApi,
      ],
    );
    await query("update orders set status = 'paid', key_id = $2, paid_at = now(), last_error = null where id = $1", [order.id, keyId]);
    const users = await query("select email from users where id = $1", [order.user_id]);
    return { label, email: users[0]?.email ?? "" };
  });
  if (!created) return null;
  return {
    email: created.email,
    label: created.label,
    expires: formatDate(new Date(issued.expiresAtMs || target)),
    subscriptionUrl: issued.subscriptionUrl,
    renewed: false,
    demo,
  };
}

async function liveRenew(order, key, plan, comment) {
  const peeked = key.panel_api === "demo" ? null : await findClient(key.client_email);
  if (!peeked && key.panel_api !== "demo") throw new Error("Ключ не найден в панели");
  const target = await rememberExpiry(order, peeked ? peeked.expiresAtMs : 0, plan.days);
  if (!peeked) {
    const created = await issueClient({
      email: key.client_email,
      subId: key.sub_id || randomBytes(8).toString("hex"),
      uuid: key.client_uuid || randomUUID(),
      expiryTime: target,
      totalBytes: nextQuotaBytes(0, plan.trafficGb),
      comment,
    });
    if (created.expiresAtMs + 5000 >= target) return created;
    return extendClientTo({ email: key.client_email, expiryTime: target, addGb: plan.trafficGb, comment });
  }
  return extendClientTo({ email: key.client_email, expiryTime: target, addGb: plan.trafficGb, comment });
}

async function demoRenew(order, key, days) {
  const current = new Date(key.expires_at).getTime();
  const target = await rememberExpiry(order, Number.isFinite(current) ? current : 0, days);
  return {
    email: key.client_email,
    uuid: key.client_uuid,
    subId: key.sub_id,
    expiresAtMs: target,
    subscriptionUrl: key.subscription_url,
    shareLink: key.share_link,
    inboundId: key.inbound_id ?? null,
    panelApi: "demo",
  };
}

function readCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const index = part.indexOf("=");
    if (index > 0) out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function requestOrigin(req) {
  const forwarded = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = forwarded || "http";
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  if ((proto !== "http" && proto !== "https") || !/^[a-zA-Z0-9.:-]+$/.test(host)) return `http://${req.headers.host}`;
  return `${proto}://${host}`;
}

function originBlocked(req) {
  const origin = req.headers.origin;
  if (!origin) {
    const site = req.headers["sec-fetch-site"];
    return !(site === "same-origin" || site === "same-site" || site === "none");
  }
  return origin !== requestOrigin(req);
}

function clientIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return (forwarded || String(req.headers["x-real-ip"] || "local")).slice(0, 64);
}

function cookieHeader(req, token) {
  const secure = requestOrigin(req).startsWith("https://") ? "; Secure" : "";
  return `${SESSION}=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 24 * 3600}${secure}`;
}

function clearCookie() {
  return `${SESSION}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
}

function readBody(req, limit = 8000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(Object.assign(new Error("too large"), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function orderJson(order, key) {
  return {
    id: order.id,
    status: order.status,
    kind: order.kind,
    amountRub: order.amount_rub,
    planTitle: order.plan_title,
    demo: order.demo,
    lastError: order.last_error,
    key: key
      ? {
          id: key.id,
          label: key.label,
          expiresAt: key.expires_at,
          subscriptionUrl: key.subscription_url,
          shareLink: key.share_link,
          demo: key.demo,
        }
      : null,
  };
}

const CSS = `
:root { --bg:#efe6d4; --ink:#1c1915; --muted:#61584c; --line:#d9cdb8; --card:#fffaf1; --green:#14352c; --lime:#dff26a; --clay:#b84324; }
* { box-sizing:border-box; }
body { margin:0; min-height:100vh; color:var(--ink); background:radial-gradient(900px 420px at 100% -10%, rgba(223,242,106,.45), transparent 60%), var(--bg); font-family:Manrope,"Segoe UI",sans-serif; line-height:1.5; }
a { color:inherit; } button, input, textarea { font:inherit; }
h1,h2,h3,.logo,.price { font-family:Unbounded,Manrope,sans-serif; letter-spacing:-.03em; }
.wrap { width:min(1080px, calc(100% - 32px)); margin:0 auto; }
.topbar { position:sticky; top:0; z-index:2; background:rgba(20,53,44,.96); color:#f6f1e6; }
.topbar-inner { display:flex; align-items:center; justify-content:space-between; gap:16px; min-height:72px; }
.logo { display:flex; align-items:center; gap:10px; text-decoration:none; font-size:22px; font-weight:700; }
.mark { width:28px; height:28px; border-radius:8px; background:var(--lime); color:var(--green); display:grid; place-items:center; }
.nav { display:flex; align-items:center; gap:10px; }
.user { max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#d7e4dc; font-size:14px; }
.hero { display:grid; grid-template-columns:1.3fr .7fr; gap:28px; padding:64px 0 28px; align-items:end; }
.kicker { margin:0 0 12px; color:#1d5342; font-weight:700; letter-spacing:.08em; text-transform:uppercase; font-size:13px; }
h1 { margin:0; font-size:clamp(40px,6vw,72px); line-height:.95; }
.lede, .muted { color:var(--muted); }
.card, .tariff, .key, .notice { background:var(--card); border:1px solid var(--line); border-radius:22px; }
.card, .key { padding:22px; }
.hero-card ol { margin:0; padding:0; list-style:none; display:grid; gap:14px; }
.hero-card li { display:grid; grid-template-columns:auto 1fr; gap:12px; }
.step { width:36px; height:36px; border-radius:50%; background:var(--green); color:var(--lime); display:grid; place-items:center; font-family:Unbounded,sans-serif; }
.section { padding:18px 0 64px; }
.tariffs, .plans { display:grid; grid-template-columns:repeat(3,1fr); gap:16px; }
.tariff { padding:22px; display:flex; flex-direction:column; gap:8px; position:relative; }
.tariff.popular { background:var(--green); color:#f6f1e6; }
.badge { position:absolute; top:16px; right:16px; background:var(--lime); color:var(--green); border-radius:999px; padding:4px 10px; font-size:12px; font-weight:700; }
.price { font-size:40px; margin:12px 0 0; }
.btn, .ghost, .lime { border:0; border-radius:999px; padding:12px 18px; cursor:pointer; text-decoration:none; display:inline-flex; align-items:center; justify-content:center; }
.btn { background:var(--green); color:#f6f1e6; } .lime { background:var(--lime); color:var(--green); font-weight:700; }
.ghost { background:transparent; color:inherit; border:1px solid currentColor; } .full { width:100%; }
.notice { padding:14px 16px; background:#fff4d2; } .error { color:var(--clay); }
.stack { display:grid; gap:14px; } label { display:grid; gap:6px; font-weight:700; }
input, textarea { width:100%; border:1px solid var(--line); background:#fff; border-radius:14px; padding:12px 14px; }
textarea { min-height:74px; } .code { font-size:28px; letter-spacing:.3em; text-align:center; font-family:Unbounded,sans-serif; }
.demo-code { background:var(--green); color:var(--lime); border-radius:18px; padding:16px; } .demo-code b { font-size:32px; letter-spacing:.18em; }
.keys { display:grid; gap:14px; } .key-head { display:flex; justify-content:space-between; gap:12px; align-items:center; }
.pill { border-radius:999px; padding:4px 10px; font-size:13px; background:#e7f6df; color:#1d5342; } .pill.warn { background:#fde4d6; color:var(--clay); }
.row { display:flex; flex-wrap:wrap; gap:8px; } .qr { width:160px; height:160px; border-radius:12px; background:#fff; }
.plan { text-align:left; background:#fff; border:1px solid var(--line); border-radius:18px; padding:14px; cursor:pointer; }
.plan strong { display:block; font-family:Unbounded,sans-serif; font-size:22px; }
button:focus-visible, a:focus-visible, input:focus { outline:3px solid var(--lime); outline-offset:2px; }
@media (max-width:800px) { .hero, .tariffs, .plans { grid-template-columns:1fr; } .user { display:none; } }
`;

function layout(user, main, script = "") {
  const nav = user
    ? `<span class="user">${esc(user.email)}</span><a class="lime" href="/cabinet">Кабинет</a>
       <form method="post" action="/api/auth/logout"><button class="ghost" type="submit">Выйти</button></form>`
    : `<a class="lime" href="/login">Войти по почте</a>`;
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Лот — ключи VPN</title><link rel="icon" href="/favicon.svg">
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400;600;700&family=Unbounded:wght@500;700&display=swap">
    <style>${CSS}</style></head><body>
    <header class="topbar"><div class="wrap topbar-inner"><a class="logo" href="/"><span class="mark">Л</span>Лот</a><nav class="nav">${nav}</nav></div></header>
    <main>${main}</main>${script ? `<script>${script}</script>` : ""}</body></html>`;
}

function planCards(plans, user) {
  return plans.map((plan) => {
    const next = `/cabinet?plan=${plan.id}`;
    const href = user ? next : `/login?next=${encodeURIComponent(next)}`;
    const popular = plan.id === "m3";
    return `<article class="tariff${popular ? " popular" : ""}">${popular ? `<span class="badge">Чаще берут</span>` : ""}
      <h3>${esc(plan.title)}</h3><p class="price">${esc(formatRub(plan.price_rub))}</p>
      <p class="muted">${plan.days} дней доступа</p><a class="${popular ? "lime" : "btn"}" href="${esc(href)}">${user ? "Оформить" : "Войти и оформить"}</a></article>`;
  }).join("");
}

function homePage(user, plans) {
  const live = liveCheckout();
  const banner = live ? "" : `<p class="notice"><strong>Демонстрационный режим. </strong>${mailConfigured() ? "" : "Письма не отправляются, код входа показывается на экране. "}${robokassaConfigured() ? "" : "Робокасса не подключена, оплата проходит учебной кнопкой. "}${xuiConfigured() ? "" : "Панель 3x-ui не подключена, ключ будет образцом и не откроет сервер. "}Настоящие платежи включатся, когда заданы Робокасса, панель и почта.</p>`;
  return layout(user, `<div class="wrap"><section class="hero"><div><p class="kicker">Ключи VPN</p><h1>Оплатили — ключ уже в кабинете</h1>
    <p class="lede">Вход по почте, без пароля. Оплата через Робокассу. После платежа Лот сам создаёт клиента в панели 3x-ui или продлевает тот ключ, который у вас уже есть.</p></div>
    <aside class="card hero-card"><ol><li><span class="step">1</span><span>Письмо с кодом и ссылкой. Логина и пароля нет.</span></li>
    <li><span class="step">2</span><span>Новый ключ или продление старого. Сумму считает сайт, не браузер.</span></li>
    <li><span class="step">3</span><span>Ссылка подписки и QR. Их можно сразу вставить в приложение.</span></li></ol></aside></section>
    ${banner}<section class="section"><h2>Тарифы</h2><p class="muted">Трафик не ограничен. Срок прибавляется к оставшимся дням, если ключ ещё действует.</p>
    <div class="tariffs">${planCards(plans, user)}</div></section>
    <footer class="muted">Ключ хранится за почтой, с которой вы вошли. Чужие ключи из кабинета не открываются.</footer></div>`);
}

function loginPage(user, next, error) {
  const script = `
    const nextPath = ${JSON.stringify(safeNext(next))};
    const ask = document.getElementById("ask");
    const box = document.getElementById("code-box");
    const note = document.getElementById("note");
    const screen = document.getElementById("screen-code");
    const err = document.getElementById("err");
    let email = "";
    ask.onsubmit = async (event) => {
      event.preventDefault();
      err.textContent = "";
      email = new FormData(ask).get("email");
      const response = await fetch("/api/auth/request", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, next: nextPath }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { err.textContent = data.error || "Не удалось отправить код"; return; }
      ask.hidden = true; box.hidden = false;
      note.textContent = data.delivery === "email" ? "Код и ссылка отправлены на " + email + "." : "Почта ещё не подключена, поэтому код показан здесь. Для настоящих клиентов его нужно отправлять письмом.";
      if (data.code) { screen.hidden = false; screen.querySelector("b").textContent = data.code; }
    };
    async function verify(code) {
      err.textContent = "";
      const response = await fetch("/api/auth/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, code }) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) { err.textContent = data.error || "Код не подошёл"; return; }
      location.href = data.next || "/cabinet";
    }
    box.onsubmit = (event) => { event.preventDefault(); verify(document.getElementById("code").value); };
    document.getElementById("code").oninput = (event) => {
      event.target.value = event.target.value.replace(/\\D/g, "").slice(0, 6);
      if (event.target.value.length === 6) verify(event.target.value);
    };
  `;
  return layout(user, `<div class="wrap section"><div class="card stack" style="max-width:480px"><p class="kicker">Вход</p><h1 style="font-size:40px">Только почта</h1>
    <p class="muted">Пароль не нужен. Пришлём одноразовый код и ссылку, они живут 15 минут.</p>
    ${error ? `<p class="error">${esc(error)}</p>` : ""}
    <form id="ask" class="stack"><label>Почта<input type="email" name="email" autocomplete="email" required placeholder="name@mail.ru"></label><button class="btn full" type="submit">Получить код</button></form>
    <form id="code-box" class="stack" hidden><p id="note"></p><div id="screen-code" class="demo-code" hidden>Код <b></b></div>
    <label>Код из письма<input id="code" class="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" required></label>
    <button class="btn full" type="submit">Войти</button></form><p id="err" class="error"></p></div></div>`, script);
}

function cabinetPage(user, plans, keys, initialPlan) {
  const cards = keys.map((key) => {
    const alive = new Date(key.expires_at).getTime() > Date.now();
    return `<article class="key"><div class="key-head"><h3 style="margin:0">${esc(key.label)}</h3><span class="${alive ? "pill" : "pill warn"}">${alive ? "действует" : "срок вышел"}</span></div>
      <p class="muted" style="margin:0">до ${esc(formatDate(key.expires_at))}</p>
      ${key.demo ? `<p class="notice">Образец. Панель 3x-ui не подключена, эта ссылка никуда не ведёт.</p>` : ""}
      <div class="row"><button class="ghost" type="button" data-copy="${esc(key.subscription_url)}">Скопировать подписку</button>
      ${key.share_link ? `<button class="ghost" type="button" data-copy="${esc(key.share_link)}">Скопировать ссылку</button>` : ""}
      <button class="btn" type="button" data-renew="${esc(key.id)}">Продлить</button></div>
      <img class="qr" alt="" src="/api/keys/${esc(key.id)}/qr"></article>`;
  }).join("");
  const picks = plans.map((plan) => `<button class="plan" type="button" data-plan="${esc(plan.id)}"><span>${esc(plan.title)}</span><strong>${esc(formatRub(plan.price_rub))}</strong><small>Перейти к оплате</small></button>`).join("");
  const script = `
    const intent = { kind: "new", keyId: "" };
    const title = document.getElementById("intent-title");
    const hint = document.getElementById("intent-hint");
    const err = document.getElementById("err");
    document.querySelectorAll("[data-renew]").forEach((button) => {
      button.onclick = () => {
        intent.kind = "renew";
        intent.keyId = button.dataset.renew;
        title.textContent = "Продлить ключ";
        hint.textContent = "Дни прибавятся к текущему сроку, если он ещё не закончился.";
      };
    });
    document.getElementById("new-key").onclick = () => {
      intent.kind = "new"; intent.keyId = "";
      title.textContent = "Новый ключ";
      hint.textContent = "Появится отдельный ключ. Старые останутся в списке.";
    };
    document.querySelectorAll("[data-plan]").forEach((button) => {
      button.onclick = async () => {
        err.textContent = "";
        button.disabled = true;
        const response = await fetch("/api/orders", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ planId: button.dataset.plan, kind: intent.kind, keyId: intent.keyId }) });
        const data = await response.json().catch(() => ({}));
        button.disabled = false;
        if (!response.ok || !data.id) { err.textContent = data.error || "Не удалось создать счёт"; return; }
        location.href = "/pay/" + data.id;
      };
    });
    document.querySelectorAll("[data-copy]").forEach((button) => {
      button.onclick = async () => {
        const value = button.dataset.copy;
        try { await navigator.clipboard.writeText(value); } catch {
          const area = document.createElement("textarea"); area.value = value; document.body.appendChild(area); area.select(); document.execCommand("copy"); area.remove();
        }
        const previous = button.textContent; button.textContent = "Скопировано"; setTimeout(() => { button.textContent = previous; }, 1400);
      };
    });
    const wanted = ${JSON.stringify(initialPlan)};
    if (wanted) document.querySelector("[data-plan='" + wanted.replace(/[^a-z0-9]/g, "") + "']")?.scrollIntoView();
  `;
  return layout(user, `<div class="wrap section"><p class="kicker">Кабинет</p><h1 style="font-size:48px">Ключи ${esc(user.email)}</h1>
    <div class="stack"><h2>Ваши ключи</h2>${keys.length ? `<div class="keys">${cards}</div>` : `<p class="muted">Пока пусто. Ниже можно купить первый ключ.</p>`}
    <section class="card stack" id="buy"><h2 id="intent-title" style="margin:0">Новый ключ</h2><p id="intent-hint" class="muted" style="margin:0">Появится отдельный ключ. Старые останутся в списке.</p>
    <button id="new-key" class="ghost" type="button">Создать новый, а не продлевать</button><div class="plans">${picks}</div><p id="err" class="error"></p></section></div></div>`, script);
}

function payPage(user, order) {
  if (!liveCheckout() || order.demo) {
    const script = `
      document.getElementById("demo-pay").onclick = async () => {
        const err = document.getElementById("err");
        err.textContent = "";
        const response = await fetch("/api/orders/${order.id}/demo-pay", { method: "POST" });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) { err.textContent = data.error || "Не вышло провести демо-оплату"; return; }
        location.href = "/pay/success?order=${order.id}";
      };
    `;
    return layout(user, `<div class="wrap section"><div class="card stack" style="max-width:560px"><p class="kicker">Счёт ${esc(order.inv_id)}</p>
      <h1 style="font-size:42px">${order.kind === "renew" ? "Продление" : "Новый ключ"}</h1><p class="price">${esc(formatRub(order.amount_rub))}</p>
      <p class="notice">Робокасса или панель ещё не подключены. Эта кнопка только показывает, как ключ появляется после оплаты. Деньги не списываются.</p>
      <button id="demo-pay" class="btn full" type="button">Провести демо-оплату</button><p id="err" class="error"></p></div></div>`, script);
  }
  const outSum = formatOutSum(order.amount_rub);
  const description = `VPN ${order.plan_title}`.slice(0, 100);
  const signature = paymentSignature({
    login: env("ROBOKASSA_MERCHANT_LOGIN"),
    outSum,
    invId: order.inv_id,
    password: env("ROBOKASSA_PASSWORD1"),
    algorithm: hashName(),
    shp: { order: order.id },
  });
  const test = env("ROBOKASSA_TEST") === "1";
  return layout(user, `<div class="wrap section"><div class="card stack" style="max-width:560px"><p class="kicker">Счёт ${esc(order.inv_id)}</p>
    <h1 style="font-size:42px">${order.kind === "renew" ? "Продление" : "Новый ключ"}</h1><p class="price">${esc(formatRub(order.amount_rub))}</p>
    <p class="muted">${esc(description)}. После оплаты ключ появится в кабинете сам.</p>
    ${test ? `<p class="notice">Включены тестовые платежи Робокассы.</p>` : ""}
    <form action="https://auth.robokassa.ru/Merchant/Index.aspx" method="post" class="stack">
      <input type="hidden" name="MerchantLogin" value="${esc(env("ROBOKASSA_MERCHANT_LOGIN"))}">
      <input type="hidden" name="OutSum" value="${esc(outSum)}">
      <input type="hidden" name="InvId" value="${esc(order.inv_id)}">
      <input type="hidden" name="Description" value="${esc(description)}">
      <input type="hidden" name="SignatureValue" value="${esc(signature)}">
      <input type="hidden" name="Shp_order" value="${esc(order.id)}">
      <input type="hidden" name="Email" value="${esc(user.email)}">
      <input type="hidden" name="Culture" value="ru"><input type="hidden" name="Encoding" value="utf-8">
      ${test ? `<input type="hidden" name="IsTest" value="1">` : ""}
      <button class="btn full" type="submit">Оплатить через Робокассу</button></form></div></div>`);
}

function successPage(user, orderId) {
  const script = `
    const box = document.getElementById("status");
    async function tick() {
      const response = await fetch("/api/orders/${orderId}", { cache: "no-store" });
      if (!response.ok) return;
      const data = await response.json();
      box.replaceChildren();
      if (data.status !== "paid" || !data.key) {
        const p = document.createElement("p");
        p.textContent = "Платёж ещё не подтверждён. Страница обновится сама.";
        box.appendChild(p);
        if (data.lastError) { const e = document.createElement("p"); e.className = "error"; e.textContent = "Ключ пока не выдан: " + data.lastError; box.appendChild(e); }
        setTimeout(tick, 2000);
        return;
      }
      const p = document.createElement("p");
      const when = new Date(data.key.expiresAt).toLocaleDateString("ru-RU", { day: "numeric", month: "long", year: "numeric" });
      p.textContent = (data.kind === "renew" ? "Ключ продлён" : "Ключ готов") + " до " + when + ".";
      box.appendChild(p);
      if (data.key.demo) { const n = document.createElement("p"); n.className = "notice"; n.textContent = "Это образец: панель 3x-ui не была подключена в момент оплаты."; box.appendChild(n); }
      const area = document.createElement("textarea"); area.readOnly = true; area.value = data.key.subscriptionUrl; box.appendChild(area);
      const row = document.createElement("div"); row.className = "row";
      const copy = document.createElement("button"); copy.className = "ghost"; copy.type = "button"; copy.textContent = "Скопировать подписку";
      copy.onclick = () => navigator.clipboard.writeText(data.key.subscriptionUrl).then(() => { copy.textContent = "Скопировано"; });
      const link = document.createElement("a"); link.className = "btn"; link.href = "/cabinet"; link.textContent = "Открыть кабинет";
      row.append(copy, link); box.appendChild(row);
      const img = document.createElement("img"); img.className = "qr"; img.alt = ""; img.src = "/api/keys/" + data.key.id + "/qr"; box.appendChild(img);
    }
    tick();
  `;
  return layout(user, `<div class="wrap section"><div class="card stack" style="max-width:640px"><p class="kicker">Оплата</p><h1>Ключ</h1><div id="status"><p>Проверяем оплату…</p></div></div></div>`, script);
}

function send(res, status, body, headers = {}) {
  const all = {
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "cache-control": "no-store",
    ...headers,
  };
  res.writeHead(status, all);
  res.end(body);
}

function json(res, data, status = 200, headers = {}) {
  send(res, status, JSON.stringify(data), { "content-type": "application/json; charset=utf-8", ...headers });
}

async function handle(req, res) {
  const url = new URL(req.url || "/", "http://localhost");
  const path = url.pathname;
  if (req.method === "GET" && path === "/favicon.svg") {
    send(res, 200, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#14352c"/><circle cx="16" cy="16" r="5.5" fill="none" stroke="#dff26a" stroke-width="2"/></svg>`, { "content-type": "image/svg+xml" });
    return;
  }
  if ((req.method === "POST" || req.method === "GET") && path === "/api/robokassa/result") {
    if (!robokassaConfigured()) return send(res, 404, "shop is not configured", { "content-type": "text/plain; charset=utf-8" });
    const params = new URLSearchParams(url.search);
    if (req.method === "POST") {
      const type = req.headers["content-type"] || "";
      const raw = await readBody(req, 20000);
      if (type.includes("application/json")) {
        const body = JSON.parse(raw || "{}");
        for (const [key, value] of Object.entries(body)) params.set(key, String(value));
      } else {
        for (const [key, value] of new URLSearchParams(raw)) params.set(key, value);
      }
    }
    const outSum = params.get("OutSum") ?? "";
    const invId = params.get("InvId") ?? "";
    const shp = {};
    for (const [key, value] of params.entries()) if (key.startsWith("Shp_") && key.length > 4) shp[key.slice(4)] = value;
    const expected = resultSignature({ outSum, invId, password: env("ROBOKASSA_PASSWORD2"), algorithm: hashName(), shp });
    if (!signaturesMatch(expected, params.get("SignatureValue") ?? "")) return send(res, 200, "bad sign", { "content-type": "text/plain; charset=utf-8" });
    const order = await getOrderByInv(invId);
    if (!order || order.demo || params.get("Shp_order") !== order.id) return send(res, 200, "order not found", { "content-type": "text/plain; charset=utf-8" });
    if (!amountsMatch(outSum, order.amount_rub)) return send(res, 200, "bad sum", { "content-type": "text/plain; charset=utf-8" });
    if (order.status === "paid") return send(res, 200, `OK${invId}`, { "content-type": "text/plain; charset=utf-8" });
    const result = await fulfillPaid(invId);
    if (result !== "ok") return send(res, 500, "temporary error", { "content-type": "text/plain; charset=utf-8" });
    return send(res, 200, `OK${invId}`, { "content-type": "text/plain; charset=utf-8" });
  }
  if (req.method === "GET" && path === "/auth/verify") {
    const result = await verifyMagic(url.searchParams.get("token") ?? "");
    if (!result) {
      res.writeHead(303, { location: "/login?error=link" });
      res.end();
      return;
    }
    res.writeHead(303, { location: result.nextPath, "set-cookie": cookieHeader(req, result.sessionToken) });
    res.end();
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD" && originBlocked(req)) return json(res, { error: "Запрос отклонён" }, 403);

  if (req.method === "POST" && path === "/api/auth/request") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const result = await requestLogin({ emailRaw: body.email, next: body.next, origin: requestOrigin(req), ip: clientIp(req) });
    if (result.error) return json(res, { error: result.error }, result.status);
    return json(res, result);
  }
  if (req.method === "POST" && path === "/api/auth/verify") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const result = await verifyCode(body.email, body.code);
    if (!result) return json(res, { error: "Код не подошёл или устарел" }, 401);
    return json(res, { ok: true, next: result.nextPath }, 200, { "set-cookie": cookieHeader(req, result.sessionToken) });
  }
  if (req.method === "POST" && path === "/api/auth/logout") {
    await destroySession(req);
    res.writeHead(303, { location: "/", "set-cookie": clearCookie() });
    res.end();
    return;
  }

  const user = await currentUser(req);
  if (req.method === "GET" && path === "/") return send(res, 200, homePage(user, await listPlans()), { "content-type": "text/html; charset=utf-8" });
  if (req.method === "GET" && path === "/login") {
    if (user) {
      res.writeHead(303, { location: safeNext(url.searchParams.get("next")) });
      res.end();
      return;
    }
    const error = url.searchParams.get("error") === "link" ? "Ссылка устарела или уже использована. Запросите новую." : "";
    return send(res, 200, loginPage(null, url.searchParams.get("next") || "", error), { "content-type": "text/html; charset=utf-8" });
  }
  if (req.method === "GET" && path === "/cabinet") {
    if (!user) {
      res.writeHead(303, { location: `/login?next=${encodeURIComponent(`/cabinet${url.search}`)}` });
      res.end();
      return;
    }
    return send(res, 200, cabinetPage(user, await listPlans(), await listKeys(user.id), url.searchParams.get("plan") || ""), { "content-type": "text/html; charset=utf-8" });
  }
  if (req.method === "GET" && (path === "/pay/success" || path === "/pay/fail")) {
    if (path === "/pay/fail") {
      return send(res, 200, layout(user, `<div class="wrap section"><div class="card stack" style="max-width:560px"><p class="kicker">Оплата</p><h1>Платёж не прошёл</h1><p>Деньги не списаны, ключ не менялся. Можно вернуться в кабинет и создать счёт ещё раз.</p><a class="btn" href="/cabinet">В кабинет</a></div></div>`), { "content-type": "text/html; charset=utf-8" });
    }
    if (!user) {
      res.writeHead(303, { location: `/login?next=${encodeURIComponent(`${path}${url.search}`)}` });
      res.end();
      return;
    }
    let orderId = url.searchParams.get("order") || "";
    if (!orderId && url.searchParams.get("InvId")) {
      const byInv = await getOrderByInv(url.searchParams.get("InvId"));
      if (byInv && byInv.user_id === user.id) orderId = byInv.id;
    }
    const found = orderId ? await getOrderForUser(orderId, user.id) : null;
    if (!found) return send(res, 200, layout(user, `<div class="wrap section"><div class="card"><h1>Счёт не найден</h1><a class="btn" href="/cabinet">В кабинет</a></div></div>`), { "content-type": "text/html; charset=utf-8" });
    return send(res, 200, successPage(user, found.order.id), { "content-type": "text/html; charset=utf-8" });
  }

  const pay = path.match(/^\/pay\/([a-f0-9]{32})$/);
  if (req.method === "GET" && pay) {
    if (!user) {
      res.writeHead(303, { location: `/login?next=${encodeURIComponent(path)}` });
      res.end();
      return;
    }
    const found = await getOrderForUser(pay[1], user.id);
    if (!found) {
      res.writeHead(303, { location: "/cabinet" });
      res.end();
      return;
    }
    if (found.order.status === "paid") {
      res.writeHead(303, { location: `/pay/success?order=${found.order.id}` });
      res.end();
      return;
    }
    return send(res, 200, payPage(user, found.order), { "content-type": "text/html; charset=utf-8" });
  }

  if (req.method === "POST" && path === "/api/orders") {
    if (!user) return json(res, { error: "Войдите по почте" }, 401);
    const body = JSON.parse((await readBody(req)) || "{}");
    const kind = body.kind === "renew" ? "renew" : body.kind === "new" ? "new" : "";
    if (!kind) return json(res, { error: "Выберите новый ключ или продление" }, 400);
    const created = await createOrder({ userId: user.id, planId: String(body.planId || ""), kind, keyId: typeof body.keyId === "string" ? body.keyId : "" });
    if (created.error) return json(res, { error: created.error }, created.status);
    return json(res, { id: created.id, demo: created.demo });
  }
  const demoPay = path.match(/^\/api\/orders\/([a-f0-9]{32})\/demo-pay$/);
  if (req.method === "POST" && demoPay) {
    if (!user) return json(res, { error: "Войдите по почте" }, 401);
    const result = await fulfillDemo(demoPay[1], user.id);
    if (result.error) return json(res, { error: result.error }, result.status);
    return json(res, { ok: true });
  }
  const orderPath = path.match(/^\/api\/orders\/([a-f0-9]{32})$/);
  if (req.method === "GET" && orderPath) {
    if (!user) return json(res, { error: "Войдите по почте" }, 401);
    const found = await getOrderForUser(orderPath[1], user.id);
    if (!found) return json(res, { error: "Счёт не найден" }, 404);
    return json(res, orderJson(found.order, found.key));
  }
  const qr = path.match(/^\/api\/keys\/([a-f0-9]{32})\/qr$/);
  if (req.method === "GET" && qr) {
    if (!user) return send(res, 401, "unauthorized", { "content-type": "text/plain" });
    const rows = await sql("select subscription_url from vpn_keys where id = $1 and user_id = $2", [qr[1], user.id]);
    const link = safeHttp(rows[0]?.subscription_url || "");
    if (!link) return send(res, 404, "not found", { "content-type": "text/plain" });
    const png = await QRCode.toBuffer(link, { width: 280, margin: 1, color: { dark: "#14352c", light: "#fffaf1" } });
    send(res, 200, png, { "content-type": "image/png" });
    return;
  }
  send(res, 404, layout(user, `<div class="wrap section"><div class="card"><h1>Страница не найдена</h1><a class="btn" href="/">На главную</a></div></div>`), { "content-type": "text/html; charset=utf-8" });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (error?.status === 413) return json(res, { error: "Слишком большой запрос" }, 413);
    console.error(error instanceof Error ? error.message : "request failed");
    if (!res.headersSent) send(res, 500, "Ошибка сервера", { "content-type": "text/plain; charset=utf-8" });
  });
});

await applyPostgresSchema();
if (!databaseUrl) await localDb();
server.listen(PORT, "0.0.0.0");
