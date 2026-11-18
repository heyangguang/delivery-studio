import React from "react";
import { Input, InputNumber, Select } from "@arco-design/web-react";
import type { Deployment } from "./shared";
import { bi, useLang } from "./i18n";
import "./executions.css";

export function ExecutionHostSummary({ host }: { host?: Deployment["execution_host"] }) {
  useLang();
  if (!host) return null;
  return <div className="ex-host-summary"><b>{bi("独立执行机", "Standalone executor")}</b><code>{host.name}</code><code>{host.ip}</code><span>{bi("负责执行部署，不计入业务机器", "Runs deployment tasks; excluded from cluster nodes")}</span></div>;
}

export function ExecutionPlacement({
  dep,
  controller,
  onChange,
}: {
  dep: Deployment;
  controller?: string;
  onChange: (patch: Partial<Deployment>) => void;
}) {
  useLang();
  const independent = !!dep.execution_host;
  const update = (patch: Partial<NonNullable<Deployment["execution_host"]>>) =>
    onChange({
      execution_host: { ...dep.execution_host!, ...patch },
      controller: undefined,
    });
  return (
    <section className="ex-placement" aria-label={bi("执行机器", "Executor host")}>
      <header>
        <b>{bi("由哪台机器执行部署", "Where deployment runs")}</b>
        <p>{bi("执行器负责运行任务和回传结果，业务机器仍以上方清单为准。", "The executor runs tasks and reports results; cluster hosts remain as listed above.")}</p>
      </header>
      <div className="ex-location-options">
        <button
          type="button"
          aria-pressed={!independent}
          onClick={() => {
            if (independent) onChange({ execution_host: undefined, controller: undefined });
          }}
        >
          <b>{bi("集群内机器", "In-cluster host")}</b>
          <span>{bi("从本次机器中选一台，兼任执行", "Pick one of the cluster hosts to act as executor")}</span>
        </button>
        <button
          type="button"
          aria-pressed={independent}
          onClick={() => {
            if (!independent)
              onChange({
                controller: undefined,
                execution_host: {
                  name: "executor",
                  ip: "",
                  repository_port: 18080,
                },
              });
          }}
        >
          <b>{bi("独立管理机", "Standalone host")}</b>
          <span>{bi("单独负责执行，不计入业务节点数", "Dedicated executor host; excluded from cluster node count")}</span>
        </button>
      </div>
      {!independent ? (
        <label className="ex-field">
          <span>{bi("执行机器", "Executor host")}</span>
          <Select
            aria-label={bi("执行机器", "Executor host")}
            value={dep.controller || undefined}
            allowClear
            placeholder={controller ? bi(`自动选择：${controller}`, `Auto: ${controller}`) : bi("自动选择", "Auto select")}
            options={dep.hosts.map((h) => ({
              value: h.name,
              label: `${h.name} · ${h.ip || bi("待填写地址", "IP pending")}`,
            }))}
            onChange={(v) => onChange({ controller: v || undefined })}
          />
        </label>
      ) : (
        <>
          <div className="ex-fields">
            <label className="ex-field">
              <span>{bi("执行机名称", "Executor name")}</span>
              <Input
                aria-label={bi("独立执行机名称", "Standalone executor name")}
                value={dep.execution_host!.name}
                onChange={(name) => update({ name })}
                placeholder={bi("与现场主机名一致", "Matches on-site hostname")}
              />
            </label>
            <label className="ex-field">
              <span>{bi("执行机 IP", "Executor IP")}</span>
              <Input
                aria-label={bi("独立执行机 IP", "Standalone executor IP")}
                value={dep.execution_host!.ip}
                onChange={(ip) => update({ ip })}
                placeholder={bi("管理机的内网地址", "Private IP of management host")}
              />
            </label>
            <label className="ex-field">
              <span>{bi("本集群的软件源端口", "Cluster repository port")}</span>
              <InputNumber
                aria-label={bi("软件源端口", "Repository port")}
                value={dep.execution_host!.repository_port}
                min={1024}
                max={65535}
                onChange={(repository_port) =>
                  update({ repository_port: repository_port || 0 })
                }
              />
            </label>
          </div>
          <p className="ex-help">
            {bi(
              "执行机当前使用与业务机器相同的操作系统版本和架构。同一管理机服务多个集群时，每个集群使用独立的软件源端口和交付目录。",
              "The executor uses the same OS version and architecture as cluster hosts. When sharing a management host across clusters, each uses an isolated repository port and delivery directory.",
            )}
          </p>
        </>
      )}
      <p className="ex-help">
        {bi(
          "生成交付后，在“现场执行”选择已接入的执行节点、检查连接和材料，再确认执行范围。",
          "After generating the delivery, select a connected execution node in On-site Execution, verify connectivity and artifacts, then confirm the scope.",
        )}
      </p>
    </section>
  );
}
