import React, { useMemo, useState } from "react";
import { Button, Input, Select, Tooltip } from "@arco-design/web-react";
import {
  IconDelete,
  IconDownload,
  IconRight,
  IconSearch,
} from "@arco-design/web-react/icon";
import { ago, size } from "./shared";
import type { ClosureRow } from "./shared";
import { bi, biv, getLang, useLang } from "./i18n";

type Sort = "recent" | "name" | "size";
const keyOf = (r: ClosureRow) => `${r.request.name}=${r.request.version}`;

const viaLabel = (via?: string) => {
  if (!via) return "";
  if (getLang() !== "en-US") return via;
  if (via === "软件源索引直取（已验签）") return "Fetched from signed index";
  if (via.startsWith("容器 ")) return `Container ${via.slice(3)}`;
  if (via === "导入") return "Imported";
  return via;
};

/** The size of one package inside a closure: its file in the pool is named "<package>_<version>_<arch>.deb". */
const fileSize = (r: ClosureRow, name: string) =>
  r.files.find((f) => f.file.startsWith(name + "_"))?.size ?? 0;

/**
 * The packages in the library as an object list. Each line says what it is and who uses it; opening it shows
 * everything that comes with it — the dependencies that would be installed — right there, with the actions.
 */
export function PackageList({
  rows,
  platformId,
  admin,
  busy,
  chosen,
  setChosen,
  remove,
  exportHref,
}: {
  rows: ClosureRow[];
  platformId: string;
  admin: boolean;
  busy: boolean;
  chosen: string[];
  setChosen: (f: (c: string[]) => string[]) => void;
  remove: (r: ClosureRow) => void;
  exportHref: (k: string) => string;
}) {
  useLang();
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<Sort>("recent");
  const [open, setOpen] = useState<string[]>([]);
  const term = q.trim().toLowerCase();
  const list = useMemo(() => {
    const l = rows.filter(
      (r) =>
        !term ||
        `${r.request.name} ${r.request.version} ${(r.used_by || []).join(" ")} ${r.packages.map((p) => p.name).join(" ")}`
          .toLowerCase()
          .includes(term),
    );
    return [...l].sort((a, b) =>
      sort === "name"
        ? a.request.name.localeCompare(b.request.name)
        : sort === "size"
          ? b.bytes - a.bytes
          : b.fetched.localeCompare(a.fetched),
    );
  }, [rows, term, sort]);
  const toggle = (k: string) =>
    setOpen((o) => (o.includes(k) ? o.filter((x) => x !== k) : [...o, k]));
  const allOpen = list.length > 0 && list.every((r) => open.includes(keyOf(r)));
  return (
    <div className="pk-wrap">
      <div className="pk-bar">
        <Input
          allowClear
          prefix={<IconSearch />}
          placeholder={bi(
            "按软件包、依赖或组件筛选",
            "Filter by package, dependency, or component",
          )}
          value={q}
          onChange={setQ}
          aria-label={bi("筛选软件包", "Filter packages")}
          style={{ flex: "1 1 240px", maxWidth: 380 }}
        />
        <Select
          size="default"
          value={sort}
          onChange={setSort}
          options={[
            { value: "recent", label: bi("最近入库", "Recently added") },
            { value: "name", label: bi("按名称", "By name") },
            { value: "size", label: bi("按大小", "By size") },
          ]}
          aria-label={bi("排序", "Sort")}
          style={{ width: biv(120, 148) }}
        />
        <Button
          type="text"
          size="small"
          onClick={() => setOpen(allOpen ? [] : list.map(keyOf))}
        >
          {allOpen ? bi("全部收起", "Collapse all") : bi("全部展开", "Expand all")}
        </Button>
      </div>
      {list.length === 0 ? (
        <p className="muted small pk-none">
          {bi(
            `没有匹配“${q.trim()}”的软件包。可以按软件包名、依赖包名或组件名找。`,
            `No packages matching "${q.trim()}". Search by package name, dependency, or component.`,
          )}
        </p>
      ) : (
        <ul
          className={`pk-list ${admin ? "" : "plain"}`}
          aria-label={bi("库里的软件包", "Packages in library")}
        >
          <li className="pk-head small" aria-hidden>
            {admin && <span />}
            <span>{bi("软件包", "Package")}</span>
            <span>{bi("被谁使用", "Used by")}</span>
            <span className="num">{bi("依赖与大小", "Deps & size")}</span>
            <span>{bi("入库", "Added")}</span>
            {admin && <span />}
          </li>
          {list.map((r) => {
            const k = keyOf(r);
            const isOpen = open.includes(k);
            const deps = r.packages.filter(
              (p) =>
                !(p.name === r.request.name && p.version === r.request.version),
            );
            return (
              <li
                key={k}
                className={`pk ${isOpen ? "open" : ""} ${r.intact ? "" : "bad"}`}
              >
                <div className="pk-row">
                  {admin && (
                    <input
                      type="checkbox"
                      checked={chosen.includes(k)}
                      onChange={(e) =>
                        setChosen((c) =>
                          e.target.checked
                            ? [...c, k]
                            : c.filter((x) => x !== k),
                        )
                      }
                      aria-label={bi(`选择 ${k}`, `Select ${k}`)}
                    />
                  )}
                  <button
                    className="pk-main"
                    onClick={() => toggle(k)}
                    aria-expanded={isOpen}
                    aria-controls={`pk-${k}`}
                  >
                    <IconRight className="pk-chev" />
                    <span className="mono pk-name">{r.request.name}</span>
                    <span className="mono small faint pk-ver">
                      {r.request.version}
                    </span>
                  </button>
                  <div className="pk-use small">
                    {r.used_by?.length ? (
                      r.used_by.map((u) => (
                        <span className="lib-use" key={u}>
                          {u}
                        </span>
                      ))
                    ) : (
                      <span className="faint">
                        {bi("暂无组件使用", "Unused")}
                      </span>
                    )}
                    {!r.intact && (
                      <span className="flag bad">
                        {bi(
                          "文件缺失或损坏，需重新下载",
                          "Files missing or corrupted; re-download required",
                        )}
                      </span>
                    )}
                  </div>
                  <div className="pk-meta num small">
                    <b>
                      {deps.length
                        ? bi(
                            `${deps.length} 个依赖`,
                            `${deps.length} ${deps.length === 1 ? "dep" : "deps"}`,
                          )
                        : bi("无依赖", "No deps")}
                    </b>
                    <span className="faint"> · {size(r.bytes)}</span>
                  </div>
                  <div className="pk-time small faint" title={viaLabel(r.via)}>
                    {ago(r.fetched)}
                  </div>
                  {admin && (
                    <div className="pk-act">
                      <Tooltip content={bi("从软件库删除", "Remove from library")} mini>
                        <Button
                          type="text"
                          status="danger"
                          size="mini"
                          icon={<IconDelete />}
                          onClick={() => remove(r)}
                          aria-label={bi(`删除 ${k}`, `Delete ${k}`)}
                          disabled={busy}
                        />
                      </Tooltip>
                    </div>
                  )}
                </div>
                {isOpen && (
                  <div className="pk-detail" id={`pk-${k}`}>
                    <p className="small muted pk-lead">
                      {deps.length
                        ? bi(
                            `装 ${r.request.name} 时，会一起装下面 ${deps.length} 个依赖包（目标系统上没有的才会下载）：`,
                            `Installing ${r.request.name} includes these ${deps.length} ${deps.length === 1 ? "dependency" : "dependencies"} (downloaded only if missing on target):`,
                          )
                        : bi(
                            `${r.request.name} 在干净的系统上不需要额外的依赖包。`,
                            `${r.request.name} requires no additional dependencies on a clean system.`,
                          )}
                    </p>
                    <ul className="pk-deps">
                      {[...r.packages]
                        .sort(
                          (a, b) =>
                            Number(b.name === r.request.name) -
                              Number(a.name === r.request.name) ||
                            a.name.localeCompare(b.name),
                        )
                        .map((p) => (
                          <li
                            key={p.name + p.version}
                            className={p.name === r.request.name ? "self" : ""}
                          >
                            <span className="pk-dtxt">
                              <span className="mono pk-dn">{p.name}</span>
                              <span className="mono small faint pk-dv">
                                {p.version}
                              </span>
                            </span>
                            <span className="num small faint pk-ds">
                              {size(fileSize(r, p.name))}
                            </span>
                          </li>
                        ))}
                    </ul>
                    <div className="pk-foot small muted">
                      <span>
                        {bi(
                          `${r.files.length} 个文件`,
                          `${r.files.length} ${r.files.length === 1 ? "file" : "files"}`,
                        )}{" "}
                        · {size(r.bytes)} · {viaLabel(r.via)}
                        {r.sources?.length
                          ? bi(
                              ` · 软件源 ${r.sources.join("、")}`,
                              ` · Sources: ${r.sources.join(", ")}`,
                            )
                          : ""}
                      </span>
                      {admin && (
                        <Button
                          size="mini"
                          icon={<IconDownload />}
                          href={exportHref(k)}
                        >
                          {bi("只导出这一项", "Export this only")}
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
