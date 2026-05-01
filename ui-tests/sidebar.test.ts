/**
 * UI tests for BC Docker Manager using vscode-extension-tester.
 *
 * These tests use Selenium WebDriver to interact with the actual VS Code UI:
 * - Activity Bar sidebar panel
 * - Tree views (Environment, Containers, Images, Volumes)
 * - Artifacts Explorer webview
 * - Context menus and commands
 *
 * Run: npm run test:ui
 */
import {
  ActivityBar,
  SideBarView,
  ViewControl,
  ViewContent,
  ViewSection,
  Workbench,
  Notification,
  NotificationsCenter,
  WebView,
  By,
} from "vscode-extension-tester";
import { expect } from "chai";

describe("BC Docker Manager - UI Tests", function () {
  this.timeout(60_000);

  let sideBar: SideBarView;

  // ─── Activity Bar & Sidebar ──────────────────────────────────

  describe("Activity Bar", () => {
    it("should show BC Docker Manager icon in activity bar", async () => {
      const activityBar = new ActivityBar();
      const controls = await activityBar.getViewControls();
      const titles = await Promise.all(controls.map((c) => c.getTitle()));
      expect(titles).to.include("BC Docker Manager");
    });

    it("should open the sidebar when clicked", async () => {
      const activityBar = new ActivityBar();
      const control = (await activityBar.getViewControl(
        "BC Docker Manager",
      )) as ViewControl;
      expect(control).to.not.be.undefined;

      const view = await control.openView();
      sideBar = view as SideBarView;
      expect(sideBar).to.not.be.undefined;
    });
  });

  // ─── Sidebar Sections (Tree Views) ──────────────────────────

  describe("Sidebar Sections", () => {
    it("should display all 5 sidebar sections", async () => {
      // Open BC Docker Manager sidebar and wait for it
      const activityBar = new ActivityBar();
      const control = (await activityBar.getViewControl(
        "BC Docker Manager",
      )) as ViewControl;
      await control.openView();
      await new Promise((r) => setTimeout(r, 5000));

      // Re-acquire sidebar after it's fully loaded
      const freshSideBar = new SideBarView();
      sideBar = freshSideBar;

      // Retry to handle stale element refs from health check refreshes
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const content = freshSideBar.getContent();
          const sections = await content.getSections();
          const titles = await Promise.all(sections.map((s) => s.getTitle()));
          const lower = titles.map((t) => t.trim().toLowerCase());

          const expected = ["environment", "artifact", "container", "image", "volume"];
          for (const exp of expected) {
            const found = lower.some((t) => t.includes(exp));
            expect(found, `Section matching "${exp}" not found in: [${titles.join(", ")}]`).to.be.true;
          }
          return;
        } catch (err: any) {
          if (attempt < 2 && (err.name === "StaleElementReferenceError" || err.message?.includes("not found in"))) {
            // Click the activity bar icon again to ensure we're on the right sidebar
            await control.openView();
            await new Promise((r) => setTimeout(r, 3000));
            continue;
          }
          throw err;
        }
      }
    });
  });

  // ─── Environment Health Checks ──────────────────────────────

  describe("Environment Health Checks", () => {
    it("should show health check items", async () => {
      const content = sideBar.getContent();
      const sections = await content.getSections();
      let envSection: ViewSection | undefined;
      for (const s of sections) {
        const title = await s.getTitle();
        if (title.toLowerCase() === "environment") {
          envSection = s;
          break;
        }
      }
      if (!envSection) {
        return; // Skip if section not found
      }

      // Retry to handle stale element references from health check refreshes
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await new Promise((r) => setTimeout(r, 3000));
          if (!(await envSection.isExpanded())) {
            await envSection.expand();
          }
          const items = await envSection.getVisibleItems();
          expect(items.length).to.be.greaterThan(0);

          // Verify items have labels
          for (const item of items) {
            const label = await (item as any).getLabel();
            expect(label).to.be.a("string").and.not.be.empty;
          }
          return; // Success
        } catch (err: any) {
          if (
            attempt < 2 &&
            err.name === "StaleElementReferenceError"
          ) {
            // Health checks refreshed the DOM - retry
            continue;
          }
          throw err;
        }
      }
    });
  });

  // ─── Artifacts Explorer (Webview) ───────────────────────────

  describe("Artifacts Explorer", () => {
    it("should open via command palette", async () => {
      const workbench = new Workbench();
      // Execute the command to open the Artifacts Explorer
      await workbench.executeCommand("BC Docker Manager: Open BC Artifacts Explorer");
      // Give the webview time to load
      await new Promise((r) => setTimeout(r, 3000));
    });

    it("should display the webview with tabs and toolbar", async () => {
      // Find the webview
      const webview = new WebView();
      try {
        await webview.switchToFrame();

        // Check for key UI elements
        const header = await webview.findWebElement(
          By.css(".header, .logo"),
        );
        expect(header).to.not.be.undefined;

        // Check tabs exist
        const tabs = await webview.findWebElements(By.css(".tab"));
        expect(tabs.length).to.be.greaterThanOrEqual(2); // sandbox + onprem

        // Check search input exists
        const search = await webview.findWebElement(By.id("searchInput"));
        expect(search).to.not.be.undefined;

        // Check country dropdown exists
        const countrySelect = await webview.findWebElement(
          By.id("countrySelect"),
        );
        expect(countrySelect).to.not.be.undefined;

        // Check major dropdown exists
        const majorSelect = await webview.findWebElement(
          By.id("majorSelect"),
        );
        expect(majorSelect).to.not.be.undefined;
      } finally {
        await webview.switchBack();
      }
    });

    it("should show sandbox tab as active by default", async () => {
      const webview = new WebView();
      try {
        await webview.switchToFrame();

        const activeTab = await webview.findWebElement(By.css(".tab.active"));
        const text = await activeTab.getText();
        expect(text.toLowerCase()).to.include("sandbox");
      } finally {
        await webview.switchBack();
      }
    });

    it("should switch to onprem tab when clicked", async () => {
      const webview = new WebView();
      try {
        await webview.switchToFrame();

        const tabs = await webview.findWebElements(By.css(".tab"));
        for (const tab of tabs) {
          const text = await tab.getText();
          if (text.toLowerCase().includes("onprem")) {
            await tab.click();
            break;
          }
        }

        // Wait for data load
        await new Promise((r) => setTimeout(r, 2000));

        const activeTab = await webview.findWebElement(By.css(".tab.active"));
        const activeText = await activeTab.getText();
        expect(activeText.toLowerCase()).to.include("onprem");
      } finally {
        await webview.switchBack();
      }
    });
  });

  // ─── Command Palette ────────────────────────────────────────

  describe("Command Palette", () => {
    it("BC Docker Manager commands should appear in command palette", async () => {
      const workbench = new Workbench();
      const input = await workbench.openCommandPrompt();

      // Type to filter BC commands
      await input.setText(">BC Docker");
      await new Promise((r) => setTimeout(r, 1000));

      const picks = await input.getQuickPicks();
      const labels = await Promise.all(picks.map((p) => p.getLabel()));

      // Should find multiple BC Docker Manager commands
      const bcCommands = labels.filter((l) => l.includes("BC Docker"));
      expect(bcCommands.length).to.be.greaterThan(5);

      await input.cancel();
    });
  });
});
