import React from "react";
import { Input, InputNumber, Select } from "@arco-design/web-react";
import type { Deployment } from "./shared";
import "./executions.css";

export function ExecutionHostSummary({ host }: { host?: Deployment["execution_host"] }) {
  if (!host) return null;
  return <div className="ex-host-summary"><b>独立执行机</b><code>{host.name}</code><code>{host.ip}</code><span>负责执行部署，不计入业务机器</span></div>;
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
  const independent = !!dep.execution_host;
  const update = (patch: Partial<NonNullable<Deployment["execution_host"]>>) =>
    onChange({
      execution_host: { ...dep.execution_host!, ...patch },
      controller: undefined,
    });
  return (
    <section className="ex-placement" aria-label="执行机器">
      <header>
        <b>由哪台机器执行部署</b>
        <p>执行器负责运行任务和回传结果，业务机器仍以上方清单为准。</p>
      </header>
      <div className="ex-location-options">
        <button
          type="button"
          aria-pressed={!independent}
          onClick={() => {
            if (independent) onChange({ execution_host: undefined, controller: undefined });
          }}
        >
          <b>集群内机器</b>
          <span>从本次机器中选一台，兼任执行</span>
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
          <b>独立管理机</b>
          <span>单独负责执行，不计入业务节点数</span>
        </button>
      </div>
      {!independent ? (
        <label className="ex-field">
          <span>执行机器</span>
          <Select
            aria-label="执行机器"
            value={dep.controller || undefined}
            allowClear
            placeholder={controller ? `自动选择：${controller}` : "自动选择"}
            options={dep.hosts.map((h) => ({
              value: h.name,
              label: `${h.name} · ${h.ip || "待填写地址"}`,
            }))}
            onChange={(v) => onChange({ controller: v || undefined })}
          />
        </label>
      ) : (
        <>
          <div className="ex-fields">
            <label className="ex-field">
              <span>执行机名称</span>
              <Input
                aria-label="独立执行机名称"
                value={dep.execution_host!.name}
                onChange={(name) => update({ name })}
                placeholder="与现场主机名一致"
              />
            </label>
            <label className="ex-field">
              <span>执行机 IP</span>
              <Input
                aria-label="独立执行机 IP"
                value={dep.execution_host!.ip}
                onChange={(ip) => update({ ip })}
                placeholder="管理机的内网地址"
              />
            </label>
            <label className="ex-field">
              <span>本集群的软件源端口</span>
              <InputNumber
                aria-label="软件源端口"
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
            执行机当前使用与业务机器相同的操作系统版本和架构。同一管理机服务多个集群时，每个集群使用独立的软件源端口和交付目录。
          </p>
        </>
      )}
      <p className="ex-help">
        生成交付后，在“现场执行”选择已接入的执行节点、检查连接和材料，再确认执行范围。
      </p>
    </section>
  );
}
