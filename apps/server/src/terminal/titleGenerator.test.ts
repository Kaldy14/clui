import { describe, expect, it } from "vitest";
import { extractPromptText } from "./titleGenerator";

describe("extractPromptText", () => {
  it("extracts prompt from top-level user_prompt field (Claude Code canonical)", () => {
    const body = JSON.stringify({ session_id: "abc", user_prompt: "Fix the login bug", cwd: "/tmp" });
    expect(extractPromptText(body)).toBe("Fix the login bug");
  });

  it("extracts prompt from top-level prompt field", () => {
    const body = JSON.stringify({ prompt: "Fix the login bug" });
    expect(extractPromptText(body)).toBe("Fix the login bug");
  });

  it("extracts prompt from top-level message field", () => {
    const body = JSON.stringify({ message: "Add a new feature" });
    expect(extractPromptText(body)).toBe("Add a new feature");
  });

  it("extracts prompt from top-level text field", () => {
    const body = JSON.stringify({ text: "Refactor the auth module" });
    expect(extractPromptText(body)).toBe("Refactor the auth module");
  });

  it("extracts prompt from top-level input field", () => {
    const body = JSON.stringify({ input: "Write unit tests" });
    expect(extractPromptText(body)).toBe("Write unit tests");
  });

  it("extracts prompt from nested data.prompt", () => {
    const body = JSON.stringify({ data: { prompt: "Deploy to staging" } });
    expect(extractPromptText(body)).toBe("Deploy to staging");
  });

  it("extracts prompt from nested context.message", () => {
    const body = JSON.stringify({ context: { message: "Update the docs" } });
    expect(extractPromptText(body)).toBe("Update the docs");
  });

  it("returns null for empty body", () => {
    expect(extractPromptText("")).toBeNull();
    expect(extractPromptText("  ")).toBeNull();
  });

  it("returns null for invalid JSON", () => {
    expect(extractPromptText("not json")).toBeNull();
  });

  it("returns null for array JSON", () => {
    expect(extractPromptText("[1,2,3]")).toBeNull();
  });

  it("returns null for object with no recognizable prompt field", () => {
    const body = JSON.stringify({ session_id: "abc", cwd: "/tmp" });
    expect(extractPromptText(body)).toBeNull();
  });

  it("trims whitespace from extracted prompt", () => {
    const body = JSON.stringify({ prompt: "  fix the bug  " });
    expect(extractPromptText(body)).toBe("fix the bug");
  });

  it("skips empty string values", () => {
    const body = JSON.stringify({ prompt: "", message: "actual prompt" });
    expect(extractPromptText(body)).toBe("actual prompt");
  });
});
