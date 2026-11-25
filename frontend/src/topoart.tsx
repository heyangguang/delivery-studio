import type { AppInfo, AppPlan } from "./shared";
import { bi, useLang } from "./i18n";

/* The banner picture of a component: its roles as rows of machines, its declared data flows as moving lines. It is
   drawn from the component's own roles, flows and ready-made plan; nothing here knows any particular product. */

const MAX_NODES = 5;

/** compact draws a smaller picture for a narrow side panel: no plan title, smaller machines. */
export function TopoArt({
  app,
  plan,
  compact,
}: {
  app: AppInfo;
  plan?: AppPlan;
  compact?: boolean;
}) {
  useLang();
  const W = compact ? 360 : 520;
  const roles = (app.roles || [])
    .map((r) => ({
      ...r,
      n: plan
        ? (plan.topology.find((t) => t.role === r.name)?.count ?? 0)
        : r.default || r.min,
    }))
    .filter((r) => r.n > 0);
  if (!roles.length) return null;
  const top = compact ? 12 : 58;
  const rowH = compact ? 74 : 88;
  const H = top + roles.length * rowH + 4;
  const nodeH = compact ? 52 : 62;
  const many = roles.some((r) => r.n > 3);
  const nodeW = compact ? (many ? 50 : 76) : many ? 82 : 112;
  const labelW = compact ? 64 : 70;
  const y = (i: number) => top + rowH * i + (rowH - nodeH) / 2;
  const shown = (n: number) => Math.min(n, MAX_NODES);
  const x = (n: number, j: number) => {
    const c = shown(n);
    const gap = compact ? 10 : 16;
    const total = c * nodeW + (c - 1) * gap;
    return labelW + (W - labelW - total) / 2 + j * (nodeW + gap); // leave room for the role labels on the left
  };
  const rowOf = (name: string) => roles.findIndex((r) => r.name === name);
  const flows = (app.flows || []).filter(
    (f) => rowOf(f.from) >= 0 && rowOf(f.to) >= 0,
  );

  return (
    <svg
      className="topo-art"
      viewBox={`0 0 ${W} ${H}`}
      style={{ display: "block", maxWidth: "100%" }}
      role="img"
      aria-label={bi(`${app.name} 的典型部署`, `Typical deployment of ${app.name}`)}
    >
      {!compact && (
        <rect
          x="1"
          y="1"
          width={W - 2}
          height={H - 2}
          rx="22"
          className="ta-panel"
        />
      )}
      {!compact && (
        <text x="26" y="36" className="ta-title">
          {plan ? plan.name : bi("典型部署", "Reference Topology")}
        </text>
      )}
      {!compact && plan?.spec && (
        <text x="26" y="52" className="ta-sub">
          {plan.spec}
        </text>
      )}
      {flows.map((f, k) => {
        const a = rowOf(f.from);
        const b = rowOf(f.to);
        const A = roles[a];
        const B = roles[b];
        if (a === b) {
          // members of one role talk to each other: a line between neighbours and an arc under the whole row
          const c = shown(A.n);
          const yy = y(a) + nodeH;
          return (
            <g key={f.id || k}>
              {Array.from({ length: c - 1 }, (_, j) => (
                <path
                  key={j}
                  className="ta-wire"
                  d={`M${x(A.n, j) + nodeW} ${y(a) + nodeH / 2} L${x(A.n, j + 1)} ${y(a) + nodeH / 2}`}
                />
              ))}
              {c > 2 && (
                <path
                  className="ta-wire soft"
                  d={`M${x(A.n, 0) + nodeW / 2} ${yy} C ${x(A.n, 0) + nodeW / 2} ${yy + 16}, ${x(A.n, c - 1) + nodeW / 2} ${yy + 16}, ${x(A.n, c - 1) + nodeW / 2} ${yy}`}
                />
              )}
            </g>
          );
        }
        const down = b > a;
        const sy = down ? y(a) + nodeH : y(a);
        const ty = down ? y(b) : y(b) + nodeH;
        const sx = x(A.n, 0) + nodeW / 2;
        return (
          <g key={f.id || k}>
            {Array.from({ length: shown(B.n) }, (_, j) => {
              const tx = x(B.n, j) + nodeW / 2;
              const my = (sy + ty) / 2;
              return (
                <path
                  key={j}
                  className={f.sync === "true" ? "ta-wire" : "ta-wire repl"}
                  d={`M${sx} ${sy} C ${sx} ${my}, ${tx} ${my}, ${tx} ${ty}`}
                />
              );
            })}
          </g>
        );
      })}
      {roles.map((r, i) => (
        <g key={r.name}>
          <text
            x={compact ? 16 : 26}
            y={y(i) + nodeH / 2 - 2}
            className="ta-role"
          >
            {r.title || r.name}
          </text>
          <text
            x={compact ? 16 : 26}
            y={y(i) + nodeH / 2 + 14}
            className="ta-sub"
          >
            {bi(`${r.n} 台`, `${r.n} ${r.n === 1 ? "host" : "hosts"}`)}
          </text>
          {Array.from({ length: shown(r.n) }, (_, j) => (
            <g key={j} transform={`translate(${x(r.n, j)} ${y(i)})`}>
              <g className={`ta-node d${(i + j) % 4}`}>
                <rect
                  width={nodeW}
                  height={nodeH}
                  rx="12"
                  className={`ta-card ${i === 0 && j === 0 ? "lead" : ""}`}
                />
                <rect
                  x="10"
                  y="12"
                  width={nodeW * 0.42}
                  height="5"
                  rx="2.5"
                  className="ta-bar"
                />
                <rect
                  x="10"
                  y="23"
                  width={nodeW * 0.24}
                  height="5"
                  rx="2.5"
                  className="ta-bar dim"
                />
                {!(compact && many) && (
                  <text x="10" y={nodeH - 10} className="ta-sub">
                    {compact
                      ? r.n > 1
                        ? `#${j + 1}`
                        : r.title || r.name
                      : `${r.title || r.name}${r.n > 1 ? ` ${j + 1}` : ""}`}
                  </text>
                )}
                <circle cx={nodeW - 11} cy="15" r="3.4" className="ta-led" />
              </g>
            </g>
          ))}
          {r.n > MAX_NODES && (
            <text
              x={x(r.n, MAX_NODES - 1) + nodeW + 10}
              y={y(i) + nodeH / 2 + 4}
              className="ta-sub"
            >
              +{r.n - MAX_NODES}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}
