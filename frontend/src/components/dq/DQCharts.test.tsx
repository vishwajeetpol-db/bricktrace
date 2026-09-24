import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RingGauge, TrendLine, DimensionDonut, Sparkline, scoreColor, gradeColor } from "./DQCharts";

describe("DQCharts", () => {
  it("RingGauge shows the rounded percentage", () => {
    render(<RingGauge value={0.953} />);
    expect(screen.getByText("95%")).toBeInTheDocument();
  });

  it("RingGauge shows an em-dash for a null score", () => {
    render(<RingGauge value={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("TrendLine prompts when there is not enough history", () => {
    render(<TrendLine points={[{ y: 0.9 }]} />);
    expect(screen.getByText(/Not enough history/i)).toBeInTheDocument();
  });

  it("TrendLine renders a chart with >=2 points", () => {
    const { container } = render(<TrendLine points={[{ y: 0.8 }, { y: 0.95 }]} />);
    expect(container.querySelector("path")).toBeTruthy();
  });

  it("DimensionDonut renders the total in the middle", () => {
    render(
      <DimensionDonut
        segments={[
          { label: "Completeness", value: 2, color: "#38bdf8" },
          { label: "Validity", value: 3, color: "#34d399" },
        ]}
      />,
    );
    expect(screen.getByText("5")).toBeInTheDocument();
  });

  it("Sparkline renders a path for >=2 values", () => {
    const { container } = render(<Sparkline values={[0.7, 0.8, 0.9]} />);
    expect(container.querySelector("path")).toBeTruthy();
  });

  it("color helpers bucket by score/grade", () => {
    expect(scoreColor(1)).toBe("#34d399");
    expect(scoreColor(0.5)).toBe("#f87171");
    expect(scoreColor(null)).toBe("#64748b");
    expect(gradeColor("A")).toBe("#34d399");
    expect(gradeColor("F")).toBe("#f87171");
  });
});
