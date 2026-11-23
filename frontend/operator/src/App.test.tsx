import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import App from "./App";

test("shows the application title", () => {
  render(<App />);
  expect(screen.getByRole("heading", { name: "AI-chat-helper Operator chat" })).toBeDefined();
});
