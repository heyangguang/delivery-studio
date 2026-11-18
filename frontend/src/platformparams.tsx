import "./platformparams.css";
import { useWb } from "./wbdoc";
import React from "react";
import {
  Button,
  Input,
  InputNumber,
  Select,
  Switch,
} from "@arco-design/web-react";
import { parseDocument, stringify } from "yaml";
import {
  HostContract,
  HostParam,
  Condition,
  CONTRACT_FILE,
} from "./hostcontract";
export function PlatformParameters({
  text,
  onChange,
  onSource,
}: {
  text: string;
  onChange: (text: string) => void;
  onSource: (line?: number) => void;
}) {
  const { problems } = useWb();
  const fileProblems = problems.filter((p) => p.file === CONTRACT_FILE);
  const doc = parseDocument(text);
  let c: HostContract;
  try {
    c = doc.toJS();
  } catch {
    c = null as unknown as HostContract;
  }
  if (
    doc.errors.length ||
    !c ||
    !Array.isArray(c.parameters) ||
    !Array.isArray(c.rules) ||
    c.parameters.some((p) => !p || typeof p !== "object") ||
    c.rules.some((r) => !r || !r.when || !Array.isArray(r.require))
  )
    return (
      <div className="note warn">
        参数定义无法解析，请到文件页修正 {CONTRACT_FILE}。
      </div>
    );
  const save = (next: HostContract) => onChange(stringify(next));
  const update = (i: number, p: Partial<HostParam>) =>
    save({
      ...c,
      parameters: c.parameters.map((x, j) => (j === i ? { ...x, ...p } : x)),
    });
  const fields = [
    { value: "disk", label: "磁盘设备" },
    { value: "partition", label: "分区" },
    { value: "initialize", label: "初始化磁盘" },
    ...c.parameters.map((p) => ({
      value: "params." + p.key,
      label: p.label || p.key,
    })),
  ];
  const valueInput = (
    field: string,
    v: unknown,
    change: (v: unknown) => void,
  ) => {
    const p = c.parameters.find((p) => "params." + p.key === field);
    const type = field === "initialize" ? "bool" : p?.type || "string";
    return type === "bool" ? (
      <span className="pp-switch"><Switch
        aria-label={"值 " + field}
        checked={v === true}
        onChange={change}
      /><span>{v === true ? "开启" : "关闭"}</span></span>
    ) : type === "enum" ? (
      <Select
        value={String(v ?? "")}
        options={p?.options || []}
        onChange={change}
      />
    ) : type === "int" ? (
      <InputNumber value={Number(v ?? 0)} onChange={change} />
    ) : (
      <Input
        value={String(v ?? "")}
        onChange={change}
        placeholder="空字符串表示不填写"
      />
    );
  };
  const condition = (v: Condition, change: (v: Condition) => void) => (
    <div className="pp-condition">
      <Select
        aria-label="规则字段"
        value={v.field}
        options={fields}
        onChange={(field) =>
          change({
            field,
            equals:
              field === "initialize"
                ? false
                : (c.parameters.find((p) => "params." + p.key === field)
                    ?.default ?? ""),
          })
        }
      />
      {valueInput(v.field, v.equals, (equals) => change({ ...v, equals }))}
    </div>
  );
  return (
    <div className="pp-editor">
      {fileProblems.length > 0 && (
        <div className="pp-errors" role="alert">
          <strong>有 {fileProblems.length} 项需要处理</strong>
          {fileProblems.map((p, i) => (
            <button key={i} onClick={() => onSource(p.line)}>
              {p.message}
              <span>定位到源码{p.line ? " · 第 " + p.line + " 行" : ""} →</span>
            </button>
          ))}
        </div>
      )}
      <div>
        <h2>公共参数</h2>
        <p className="muted">
          设置用户创建交付时可以填写的内容。发布后，表单与部署校验同步生效。
          <button className="pp-source" onClick={() => onSource()}>
            查看参数定义 →
          </button>
        </p>
      </div>
      {c.parameters.map((p, i) => (
        <section key={i} className="pp-card">
          <div className="pp-card-head">
            <strong>{p.label || "新参数"}</strong>
            <Button
              type="text"
              status="danger"
              onClick={() =>
                save({
                  ...c,
                  parameters: c.parameters.filter((_, j) => i !== j),
                })
              }
            >
              删除参数
            </Button>
          </div>
          <div className="fgrid">
            <div className="frow">
              参数键
              <Input
                aria-label={"参数键 " + (i + 1)}
                value={p.key}
                onChange={(key) => update(i, { key })}
              />
            </div>
            <div className="frow">
              显示名称
              <Input
                aria-label={"参数名称 " + (i + 1)}
                value={p.label}
                onChange={(label) => update(i, { label })}
              />
            </div>
            <div className="frow">
              类型
              <Select
                value={p.type}
                options={[
                  { value: "string", label: "文本" },
 { value: "path", label: "目录路径" },
                  { value: "int", label: "整数" },
                  { value: "bool", label: "开关" },
                  { value: "enum", label: "选项" },
                ]}
                onChange={(type) =>
                  update(i, {
                    type,
                    default: type === "bool" ? false : type === "int" ? 0 : "",
                    options: type === "enum" ? [] : undefined,
                    min: undefined,
                    max: undefined,
                  })
                }
              />
            </div>
            <div className="frow">
              默认值
              {valueInput("params." + p.key, p.default, (v) =>
                update(i, { default: v }),
              )}
            </div>
            {p.type === "int" && (
              <>
                <div className="frow">
                  最小值
                  <InputNumber
                    value={p.min}
                    onChange={(min) => update(i, { min })}
                  />
                </div>
                <div className="frow">
                  最大值
                  <InputNumber
                    value={p.max}
                    onChange={(max) => update(i, { max })}
                  />
                </div>
              </>
            )}
          </div>
          {p.type === "enum" && (
            <div className="pp-options">
              <div className="pp-options-head">
                <span>保存值</span>
                <span>显示名称</span>
                <span>操作</span>
              </div>
              {(p.options || []).map((o, j) => (
                <div key={j} className="pp-option">
                  <Input
                    aria-label="选项值"
                    value={o.value}
                    placeholder="保存的值"
                    onChange={(value) =>
                      update(i, {
                        options: p.options!.map((x, k) =>
                          k === j ? { ...x, value } : x,
                        ),
                      })
                    }
                  />
                  <Input
                    aria-label="选项名称"
                    value={o.label}
                    placeholder="用户看到的名称"
                    onChange={(label) =>
                      update(i, {
                        options: p.options!.map((x, k) =>
                          k === j ? { ...x, label } : x,
                        ),
                      })
                    }
                  />
                  <Button
                    type="text"
                    status="danger"
                    aria-label={"删除选项 " + (j + 1)}
                    onClick={() =>
                      update(i, {
                        options: p.options!.filter((_, k) => k !== j),
                      })
                    }
                  >
                    删除
                  </Button>
                </div>
              ))}
              <Button
                onClick={() =>
                  update(i, {
                    options: [...(p.options || []), { value: "", label: "" }],
                  })
                }
              >
                添加选项
              </Button>
            </div>
          )}
          <div className="frow">
            填写说明
            <Input.TextArea
              value={p.help || ""}
              onChange={(help) => update(i, { help })}
            />
          </div>
        </section>
      ))}
      <Button
        long
        onClick={() =>
          save({
            ...c,
            parameters: [
              ...c.parameters,
              { key: "", label: "", type: "string", default: "" },
            ],
          })
        }
      >
        添加公共参数
      </Button>
      <div>
        <h2>联动与校验规则</h2>
        <p className="muted">
          条件满足时检查要求值。隐藏字段会在用户切换选项时自动改为要求值；接口提交的冲突值仍会报错。规则不会执行脚本。
        </p>
      </div>
      {c.rules.map((r, i) => {
        const updateRule = (patch: Partial<typeof r>) =>
          save({
            ...c,
            rules: c.rules.map((x, j) => (j === i ? { ...x, ...patch } : x)),
          });
        return (
          <section key={i} className="pp-card pp-rule">
            <div className="pp-card-head">
              <strong>规则 {i + 1}</strong>
              <span className="muted">{r.id || "未命名"}</span>
            </div>
            {(r.hide || []).includes("initialize") &&
              (r.require || []).some(
                (v) => v.field === "initialize" && v.equals === true,
              ) && (
                <div className="pp-rule-error" role="alert">
                  初始化磁盘不能在隐藏后自动开启。请将下方“初始化磁盘”的要求值改为“关闭”，或移除对它的隐藏设置。
                </div>
              )}
            <div className="frow">
              规则标识
              <Input value={r.id} onChange={(id) => updateRule({ id })} />
            </div>
            <strong>当以下字段等于</strong>
            {condition(r.when, (when) => updateRule({ when }))}
            <strong>必须满足</strong>
            {(r.require || []).map((v, j) => (
              <div key={j}>
                {condition(v, (value) =>
                  updateRule({
                    require: r.require.map((x, k) => (k === j ? value : x)),
                  }),
                )}
                <Button
                  type="text"
                  onClick={() =>
                    updateRule({
                      require: r.require.filter((_, k) => k !== j),
                      hide: (r.hide || []).filter((x) => x !== v.field),
                    })
                  }
                >
                  移除条件
                </Button>
              </div>
            ))}
            <Button
              onClick={() =>
                updateRule({
                  require: [
                    ...(r.require || []),
                    { field: "initialize", equals: false },
                  ],
                })
              }
            >
              添加要求
            </Button>
            <div className="frow">
              隐藏并自动设置的字段
              <Select
                mode="multiple"
                value={r.hide || []}
                options={fields.filter((f) =>
                  (r.require || []).some((v) => v.field === f.value),
                )}
                onChange={(hide) => updateRule({ hide })}
              />
            </div>
            <div className="frow">
              冲突提示
              <Input
                value={r.message}
                onChange={(message) => updateRule({ message })}
              />
            </div>
            <Button
              status="danger"
              type="text"
              onClick={() =>
                save({ ...c, rules: c.rules.filter((_, j) => j !== i) })
              }
            >
              删除规则
            </Button>
          </section>
        );
      })}
      <Button
        long
        onClick={() =>
          save({
            ...c,
            rules: [
              ...c.rules,
              {
                id: "",
                when: { field: "initialize", equals: true },
                require: [],
                hide: [],
                message: "",
              },
            ],
          })
        }
      >
        添加规则
      </Button>
    </div>
  );
}
