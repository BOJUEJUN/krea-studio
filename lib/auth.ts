import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { storeGet, storePut } from "./store";

/**
 * 2026-11-05 (用户: 能登录不？历史按用户分类): accounts with a username and password. New accounts need the
 * invite code (env INVITE_CODE); the first account becomes the owner and keeps the history made before login
 * existed. Sessions are signed cookies (env SESSION_SECRET), 30 days.
 */
export const SESSION_COOKIE = "ais_session";
const SESSION_DAYS = 30;

type UserRecord = { name: string; salt: string; hash: string; owner?: boolean; createdAt: number };
type UserFile = { users: UserRecord[] };

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error("登录服务未配置");
  return s;
}

async function readUsers(): Promise<UserFile> {
  const bytes = await storeGet("users.json");
  if (!bytes) return { users: [] };
  try {
    const data = JSON.parse(bytes.toString("utf8"));
    return Array.isArray(data?.users) ? data : { users: [] };
  } catch {
    return { users: [] };
  }
}

function hashPassword(password: string, salt: string): string {
  return scryptSync(password, salt, 32).toString("hex");
}

export function validName(name: string): boolean {
  return /^[\p{L}\p{N}_.-]{2,20}$/u.test(name);
}

export async function registerUser(name: string, password: string, invite: string): Promise<UserRecord> {
  const expected = process.env.INVITE_CODE || "";
  if (!expected || invite.trim() !== expected) throw new Error("邀请码不对");
  if (!validName(name)) throw new Error("用户名 2–20 个字，只能用字母、数字、中文、_ . -");
  if (password.length < 6) throw new Error("密码至少 6 位");
  const file = await readUsers();
  if (file.users.some((u) => u.name.toLowerCase() === name.toLowerCase())) throw new Error("这个用户名已经有人用了");
  const salt = randomBytes(16).toString("hex");
  const user: UserRecord = { name, salt, hash: hashPassword(password, salt), owner: file.users.length === 0, createdAt: Date.now() };
  file.users.push(user);
  await storePut("users.json", JSON.stringify(file), "application/json");
  return user;
}

/**
 * 2026-11-05 (用户: 不弄真的登录，只记录用户好分历史): a name is enough. The first name ever used becomes the
 * owner and keeps the history from before names existed.
 */
export async function enterByName(name: string): Promise<UserRecord> {
  if (!validName(name)) throw new Error("名字 2–20 个字，只能用字母、数字、中文、_ . -");
  const file = await readUsers();
  const found = file.users.find((u) => u.name.toLowerCase() === name.toLowerCase());
  if (found) return found;
  const user: UserRecord = { name, salt: "", hash: "", owner: file.users.length === 0, createdAt: Date.now() };
  file.users.push(user);
  await storePut("users.json", JSON.stringify(file), "application/json");
  return user;
}

/**
 * 2026-11-05 (用户: 弄成假登录): looks like a normal sign-in. A new name is created with the password typed the
 * first time (a name made earlier without a password takes it now); after that the same password is needed.
 */
export async function signIn(rawName: string, password: string): Promise<UserRecord> {
  // A phone number may be typed with spaces, dashes or +86.
  const digits = rawName.replace(/[\s-]/g, "").replace(/^\+?86(?=1\d{10}$)/, "");
  const name = /^1\d{10}$/.test(digits) ? digits : rawName.trim();
  if (!validName(name)) throw new Error("请填手机号，或 2–20 个字的账号（字母、数字、中文、_ . -）");
  if (password.length < 4) throw new Error("密码至少 4 位");
  const file = await readUsers();
  let user = file.users.find((u) => u.name.toLowerCase() === name.toLowerCase());
  if (user && user.hash) {
    const a = Buffer.from(hashPassword(password, user.salt), "hex");
    const b = Buffer.from(user.hash, "hex");
    if (a.length !== b.length || !timingSafeEqual(a, b)) throw new Error("密码不对");
    return user;
  }
  const salt = randomBytes(16).toString("hex");
  if (user) {
    user.salt = salt;
    user.hash = hashPassword(password, salt);
  } else {
    user = { name, salt, hash: hashPassword(password, salt), owner: file.users.length === 0, createdAt: Date.now() };
    file.users.push(user);
  }
  await storePut("users.json", JSON.stringify(file), "application/json");
  return user;
}

export async function checkLogin(name: string, password: string): Promise<UserRecord | null> {
  const file = await readUsers();
  const user = file.users.find((u) => u.name.toLowerCase() === name.trim().toLowerCase());
  if (!user) return null;
  const a = Buffer.from(hashPassword(password, user.salt), "hex");
  const b = Buffer.from(user.hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b) ? user : null;
}

/** The owner account (keeps the history from before accounts existed). */
export async function ownerName(): Promise<string | null> {
  const file = await readUsers();
  return file.users.find((u) => u.owner)?.name ?? null;
}

export function makeSession(name: string): { value: string; maxAge: number } {
  const exp = Date.now() + SESSION_DAYS * 86_400_000;
  const body = Buffer.from(JSON.stringify({ u: name, exp })).toString("base64url");
  const sig = createHmac("sha256", secret()).update(body).digest("base64url");
  return { value: `${body}.${sig}`, maxAge: SESSION_DAYS * 86_400 };
}

/** Username from the request's session cookie, or null. */
export function sessionUser(req: Request): string | null {
  const cookie = req.headers.get("cookie") || "";
  const raw = cookie
    .split(/;\s*/)
    .find((c) => c.startsWith(SESSION_COOKIE + "="))
    ?.slice(SESSION_COOKIE.length + 1);
  if (!raw) return null;
  const [body, sig] = decodeURIComponent(raw).split(".");
  if (!body || !sig) return null;
  try {
    const good = createHmac("sha256", secret()).update(body).digest("base64url");
    if (good.length !== sig.length || !timingSafeEqual(Buffer.from(good), Buffer.from(sig))) return null;
    const data = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    return typeof data?.u === "string" && Number(data.exp) > Date.now() ? data.u : null;
  } catch {
    return null;
  }
}

export function unauthorized() {
  return Response.json({ ok: false, error: "请先登录", needLogin: true }, { status: 401 });
}
