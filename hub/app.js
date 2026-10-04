const state = document.querySelector("#module-state");
const version = document.querySelector("#version");
const repository = document.querySelector("#repository");
const message = document.querySelector("#message");
const openFullApp = document.querySelector("#open-full-app");
const backHome = document.querySelector("#back-home");

async function init() {
  const context = await window.hubModule.getContext();

  version.textContent = context.version ?? "不明";
  repository.textContent = context.repository ?? "不明";

  state.textContent = context.fullAppAvailable ? "統合中 · フルアプリ利用可" : "統合中";
  state.dataset.state = "ok";

  openFullApp.disabled = !context.fullAppAvailable;
  if (!context.fullAppAvailable) {
    openFullApp.textContent = "フルアプリ未検出";
  }
}

openFullApp.addEventListener("click", async () => {
  message.textContent = "フルアプリを起動しています…";
  openFullApp.disabled = true;

  const result = await window.hubModule.openFullApp();
  message.textContent = result.ok ? "起動しました。" : (result.error ?? "起動できませんでした。");
  openFullApp.disabled = false;
});

backHome.addEventListener("click", async () => {
  await window.hubModule.showHome();
});

init().catch((error) => {
  state.textContent = "読込失敗";
  state.dataset.state = "error";
  message.textContent = error.message;
});
