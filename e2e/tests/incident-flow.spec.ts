import { test, expect } from "@playwright/test";

test("game day: detect → investigate → cite → verified fix → human approval → draft PR", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Responder" }).click();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Production overview")).toBeVisible();
  // start from a clean slate when the stack is reused between runs
  const open = await (await page.request.get("/api/incidents?status=open&limit=200")).json();
  for (const i of open) await page.request.patch(`/api/incidents/${i.id}`, { data: { status: "resolved" } });

  await page.getByRole("button", { name: "Simulate" }).click();
  await page.getByText("Payments: client timeout lowered below Stripe p99").click();

  const card = page.locator("a[href^='/incidents/']").filter({ hasText: /Payments|Checkout/ }).first();
  await expect(card).toBeVisible({ timeout: 150_000 });
  await card.click();

  await expect(page.getByText("Root-cause hypotheses")).toBeVisible();
  await expect(page.getByText(/Fix proposed|Proposed fixes/).first()).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(/timeoutMs/).first()).toBeVisible();
  await expect(page.getByText(/checks/).first()).toBeVisible();

  await page.getByRole("button", { name: /Approve & open draft PR/ }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText(/Draft PR opened/).first()).toBeVisible();
  await expect(page.getByRole("link", { name: /View PR/ })).toBeVisible();
});

test("viewers can watch but not approve", async ({ page }) => {
  await page.goto("/login");
  await page.getByRole("button", { name: "Viewer" }).click();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Production overview")).toBeVisible();
  await expect(page.getByRole("button", { name: "Simulate" })).toHaveCount(0);
});
