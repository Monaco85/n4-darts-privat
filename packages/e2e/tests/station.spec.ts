import { board, expect, test } from "./fixtures.ts";

test("a quick match on the station, from setup to Done", async ({ page, n4: _ }) => {
  const board1 = board(1);
  await page.goto("/station/1");

  // Setup: pick two players, keep the default settings (301, single out), then the lineup.
  await page.getByRole("button", { name: /Ann/ }).click();
  await page.getByRole("button", { name: /Bob/ }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Ann vs Bob" })).toBeVisible();
  await page.getByRole("button", { name: "Start" }).click();

  const visit = page.getByRole("region", { name: "Current visit" });
  // The big score on each card; the cards' visit history repeats what's left.
  const scores = page.locator(".scoreboard .remaining");
  await expect(visit.getByText("Ann to throw")).toBeVisible();

  // A dart from the board shows up, and the score follows.
  await board1.dart("T20");
  await expect(visit.getByRole("button", { name: "Correct dart 1: T20" })).toBeVisible();
  await expect(scores.getByText("241", { exact: true })).toBeVisible();

  // Correct it: T20 was really a D20.
  await visit.getByRole("button", { name: "Correct dart 1: T20" }).click();
  const picker = page.getByRole("dialog", { name: "Correct T20" });
  await picker.getByRole("button", { name: "Double" }).click();
  await picker.getByRole("button", { name: "20", exact: true }).click();
  await expect(visit.getByRole("button", { name: "Correct dart 1: D20" })).toBeVisible();
  await expect(scores.getByText("261", { exact: true })).toBeVisible();

  // A dart the board missed, added by hand.
  await visit.getByRole("button", { name: "Add dart 2" }).click();
  const adder = page.getByRole("dialog", { name: "Add dart 2" });
  await adder.getByRole("button", { name: "Single" }).click();
  await adder.getByRole("button", { name: "5", exact: true }).click();
  await expect(visit.getByRole("button", { name: "Correct dart 2: S5" })).toBeVisible();

  // Undo drops the visit in progress.
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(visit.getByRole("button", { name: /Correct dart 1/ })).toHaveCount(0);
  await expect(scores.getByText("301", { exact: true })).toHaveCount(2);

  // Three darts end the visit; the takeout passes the turn.
  await board1.takeout();
  for (const dart of ["T20", "T20", "T20"]) await board1.dart(dart);
  await expect(visit.getByText("Remove darts")).toBeVisible();
  await board1.takeout();
  await expect(visit.getByText("Bob to throw")).toBeVisible();
  await expect(scores.getByText("121", { exact: true })).toBeVisible();

  for (const dart of ["M17", "M17", "M17"]) await board1.dart(dart);
  await expect(visit.getByText("Remove darts")).toBeVisible();
  await board1.takeout();

  // Ann checks out 121.
  for (const dart of ["T20", "T20", "S1"]) await board1.dart(dart);
  await expect(page.getByRole("heading", { name: "Game shot" })).toBeVisible();
  await expect(page.getByText("Ann wins")).toBeVisible();

  await page.getByRole("button", { name: "Done" }).click();
  await expect(page.getByRole("heading", { name: "New match" })).toBeVisible();
});
