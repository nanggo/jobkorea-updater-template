const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { AuthStateStore } = require("../dist/services/authState");
const { AuthenticationError } = require("../dist/types");

const state = {
  cookies: [{ name: "session", value: "synthetic-secret", domain: ".jobkorea.co.kr", path: "/", expires: -1, httpOnly: true, secure: true, sameSite: "Lax" }],
  origins: [{ origin: "https://www.jobkorea.co.kr", localStorage: [{ name: "remember", value: "synthetic-device" }] }],
};
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "jobkorea-auth-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "private");
  return { root, directory, file: path.join(directory, "state.json"), store: new AuthStateStore(directory, "synthetic-account") };
}

test("missing state is optional; saved state is private, atomic, and account-bound", async t => {
  const { directory, file, store } = await fixture(t);
  assert.equal(await store.load(), undefined);
  await store.save(state);
  assert.deepEqual(await store.load(), state);
  assert.equal((await fs.stat(directory)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(await fs.readdir(directory), ["state.json"]);
  assert.equal((await fs.readFile(file, "utf8")).includes("synthetic-account"), false);
  await assert.rejects(new AuthStateStore(directory, "another-account").load(), /계정이 일치하지/);
  await store.save({ cookies: [], origins: [] });
  assert.deepEqual(await store.load(), { cookies: [], origins: [] });
});

test("keeps JobKorea state and excludes lookalike and third-party origins", async t => {
  const { store } = await fixture(t);
  await store.save({
    cookies: [...state.cookies, { ...state.cookies[0], domain: ".jobkorea.co.kr.evil.example" }],
    origins: [...state.origins, { origin: "https://tracker.example", localStorage: [{ name: "tracking", value: "discard" }] }],
  });
  assert.deepEqual(await store.load(), state);
});

test("rejects broad permissions and symlinks without modifying their targets", async t => {
  const { root, directory, file, store } = await fixture(t);
  await store.save(state);
  await fs.chmod(file, 0o644);
  await assert.rejects(store.load(), /현재 사용자만/);
  await assert.rejects(store.save(state), /현재 사용자만/);
  await fs.chmod(file, 0o600);
  await fs.chmod(directory, 0o755);
  await assert.rejects(store.load(), /현재 사용자만/);
  await fs.chmod(directory, 0o700);
  await fs.unlink(file);
  const target = path.join(root, "target");
  await fs.writeFile(target, "do not change", { mode: 0o600 });
  await fs.symlink(target, file);
  await assert.rejects(store.load(), AuthenticationError);
  await assert.rejects(store.save(state), AuthenticationError);
  assert.equal(await fs.readFile(target, "utf8"), "do not change");
});

test("malformed state fails closed without including file contents in the error", async t => {
  const { file, store } = await fixture(t);
  await store.save(state);
  await fs.writeFile(file, '{"private":"synthetic-secret');
  await assert.rejects(store.load(), error => error instanceof AuthenticationError && !error.message.includes("synthetic-secret"));
  await store.save(state);
  const data = JSON.parse(await fs.readFile(file, "utf8"));
  data.state.cookies[0].value = { private: "synthetic-secret" };
  await fs.writeFile(file, JSON.stringify(data));
  await assert.rejects(store.load(), error => error instanceof AuthenticationError && !error.message.includes("synthetic-secret"));
});

test("does not allow auth files inside the checkout or relative paths", () => {
  assert.throws(() => new AuthStateStore(path.join(process.cwd(), ".auth"), "account"), /저장소 밖/);
  assert.throws(() => new AuthStateStore("relative", "account"), /절대 경로/);
});
