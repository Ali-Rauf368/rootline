import { test, expect, type Browser } from "@playwright/test";

async function signedIn(browser: Browser, role: "Admin" | "Responder" | "Viewer") {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto("/login");
  await page.getByRole("button", { name: role, exact: true }).click();
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByText("Production overview")).toBeVisible();
  return { ctx, page };
}

test("admin flips a toggle and every console sees it live", async ({ browser }) => {
  const admin = await signedIn(browser, "Admin");
  const viewer = await signedIn(browser, "Viewer");
  await admin.page.goto("/settings");
  const sw = admin.page.getByRole("switch", { name: "Maintenance mode" });
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await sw.click();
  await admin.page.getByRole("dialog").getByRole("button", { name: "Confirm" }).click();
  await expect(sw).toHaveAttribute("aria-checked", "true");
  // pushed over Socket.IO, no reload in the viewer's tab
  await expect(viewer.page.getByText("Maintenance mode is on.")).toBeVisible({ timeout: 10_000 });
  await sw.click(); // turning it off needs no confirmation
  await expect(viewer.page.getByText("Maintenance mode is on.")).toHaveCount(0, { timeout: 10_000 });
  await viewer.page.goto("/settings");
  await expect(viewer.page.getByRole("switch", { name: "Maintenance mode" })).toBeDisabled();
  await admin.ctx.close(); await viewer.ctx.close();
});

test("war room: presence, typing and chat across two responders", async ({ browser }) => {
  const a = await signedIn(browser, "Responder");
  const b = await signedIn(browser, "Admin");
  const inc = await (await a.page.request.post("/api/incidents", { data: { title: "E2E war-room drill", severity: "sev4", services: ["catalog"] } })).json();
  const href = `/incidents/${inc.id}`;
  await a.page.goto(href);
  await b.page.goto(href);
  await expect(a.page.getByText("2 in the war room")).toBeVisible({ timeout: 15_000 });

  const msg = `Rolling back now ${Date.now()}`;
  await b.page.getByLabel("Chat message").fill("checking…");
  await expect(a.page.getByText(/is typing/)).toBeVisible({ timeout: 10_000 });
  await b.page.getByLabel("Chat message").fill(msg);
  await b.page.getByRole("button", { name: "Send" }).click();
  await expect(a.page.getByText(msg)).toBeVisible({ timeout: 10_000 });

  await b.ctx.close();
  await expect(a.page.getByText("Only you here")).toBeVisible({ timeout: 15_000 });
  await a.page.request.patch(href.replace("/incidents", "/api/incidents"), { data: { status: "resolved" } });
  await a.ctx.close();
});
