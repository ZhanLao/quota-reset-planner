import { expect, test } from "@playwright/test";

const appPath = process.env.PLAYWRIGHT_BASE_PATH ?? "/";

test("中文表单初始化、参数修改和移动端宽度", async ({ page }) => {
  await page.goto(appPath);
  await expect(page.getByRole("heading", { name: "额度重置策略工作台" })).toBeVisible();
  await expect(page.getByText("真实当前状态")).toBeVisible();
  await expect(page.getByText("当前没有重置卡")).toBeVisible();
  await page.getByRole("button", { name: "+ 添加卡片" }).click();
  await expect(page.getByLabel("卡片名称")).toHaveCount(1);
  await page.getByLabel("当前剩余额度（%）").fill("35");
  await page.getByRole("button", { name: "+ 添加未来重置" }).click();
  await expect(page.getByLabel("强制重置名称")).toHaveCount(1);
  await expect(page.locator("body")).not.toHaveCSS("overflow-x", "scroll");
});

test("首次加载后可在离线状态重新打开", async ({ page, context }) => {
  await page.goto(appPath);
  await expect(page.getByRole("heading", { name: "额度重置策略工作台" })).toBeVisible();
  await page.waitForTimeout(1_500);
  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole("heading", { name: "额度重置策略工作台" })).toBeVisible();
});

test("生产页面能在 Worker 中加载同源 WASM 并完成真实求解", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(appPath);
  await page.getByLabel("速度对比样本").fill("2.5");
  await page.getByLabel("时间步长").selectOption("180");
  await page.getByRole("button", { name: "快速计算当前速度" }).click();
  await expect(page.getByText("确定性最优策略")).toBeVisible({ timeout: 110_000 });
  await expect(page.getByText("最优策略无需在订阅结束前使用重置卡")).toBeVisible();
});

test("真实求解后明确显示重置卡使用日期与卡名", async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto(appPath);
  await page.getByRole("button", { name: "+ 添加卡片" }).click();
  await page.getByLabel("时间步长").selectOption("180");
  await page.getByRole("button", { name: "快速计算当前速度" }).click();
  await expect(page.getByRole("heading", { name: "重置卡使用计划" })).toBeVisible({ timeout: 110_000 });
  await expect(page.getByRole("cell", { name: "新重置卡" }).first()).toBeVisible();
});
