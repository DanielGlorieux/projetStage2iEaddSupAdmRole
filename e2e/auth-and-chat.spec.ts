import { expect, test } from "@playwright/test";

test("login flow and chat contact picker are accessible", async ({ page }) => {
  await page.goto("/");

  await expect(page.locator("#email")).toBeVisible();
  await expect(page.locator("#password")).toBeVisible();

  await page.locator("#email").fill("supervisor@2ie-edu.org");
  await page.locator("#password").fill("supervisor123");
  await page.getByRole("button", { name: "Se connecter à LED" }).click();

  await expect(page.getByText("Messages", { exact: false })).toBeVisible();

  await page.getByText("Messages", { exact: false }).first().click();

  await expect(
    page.getByText("Démarrer une conversation", { exact: false })
  ).toBeVisible();
});
