import "./platformparams.css";
import { useWb } from "../catalog/wbdoc";
import { bi, useLang } from "../../app/i18n";
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
  useLang();
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
        {bi(
          `参数定义无法解析，请到文件页修正 ${CONTRACT_FILE}。`,
          `Unable to parse parameter definitions; please fix ${CONTRACT_FILE} on the Files tab.`,
        )}
      </div>
    );
  const save = (next: HostContract) => onChange(stringify(next));
  const update = (i: number, p: Partial<HostParam>) =>
    save({
      ...c,
      parameters: c.parameters.map((x, j) => (j === i ? { ...x, ...p } : x)),
    });
  const fields = [
    { value: "disk", label: bi("磁盘设备", "Disk Device") },
    { value: "partition", label: bi("分区", "Partition") },
    { value: "initialize", label: bi("初始化磁盘", "Initialize Disk") },
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
        aria-label={bi("值 ", "Value ") + field}
        checked={v === true}
        onChange={change}
      /><span>{v === true ? bi("开启", "On") : bi("关闭", "Off")}</span></span>
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
        placeholder={bi("空字符串表示不填写", "Empty string means unset")}
      />
    );
  };
  const condition = (v: Condition, change: (v: Condition) => void) => (
    <div className="pp-condition">
      <Select
        aria-label={bi("规则字段", "Rule field")}
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
          <strong>
            {bi(
              `有 ${fileProblems.length} 项需要处理`,
              `${fileProblems.length} issue(s) to resolve`,
            )}
          </strong>
          {fileProblems.map((p, i) => (
            <button key={i} type="button" onClick={() => onSource(p.line)}>
              {p.message}
              <span>
                {bi("定位到源码", "Go to source")}
                {p.line ? bi(` · 第 ${p.line} 行`, ` · Line ${p.line}`) : ""} →
              </span>
            </button>
          ))}
        </div>
      )}
      <div>
        <h2>{bi("公共参数", "Platform Parameters")}</h2>
        <p className="muted">
          {bi(
            "设置用户创建交付时可以填写的内容。发布后，表单与部署校验同步生效。",
            "Define fields users fill in when creating a delivery. Once published, both the form and deployment validation update together.",
          )}
          <button type="button" className="pp-source" onClick={() => onSource()}>
            {bi("查看参数定义 →", "View definition →")}
          </button>
        </p>
      </div>
      {(c.parameters || []).map((p, i) => (
        <section key={i} className="pp-card">
          <div className="pp-card-head">
            <strong>{p.label || bi("新参数", "New parameter")}</strong>
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
              {bi("删除参数", "Delete parameter")}
            </Button>
          </div>
          <div className="fgrid">
            <div className="frow">
              {bi("参数键", "Parameter Key")}
              <Input
                aria-label={bi("参数键 ", "Parameter key ") + (i + 1)}
                value={p.key}
                onChange={(key) => update(i, { key })}
              />
            </div>
            <div className="frow">
              {bi("显示名称", "Display Label")}
              <Input
                aria-label={bi("参数名称 ", "Parameter label ") + (i + 1)}
                value={p.label}
                onChange={(label) => update(i, { label })}
              />
            </div>
            <div className="frow">
              {bi("类型", "Type")}
              <Select
                value={p.type}
                options={[
                  { value: "string", label: bi("文本", "Text") },
                  { value: "path", label: bi("目录路径", "Directory path") },
                  { value: "int", label: bi("整数", "Integer") },
                  { value: "bool", label: bi("开关", "Toggle") },
                  { value: "enum", label: bi("选项", "Select") },
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
              {bi("默认值", "Default Value")}
              {valueInput("params." + p.key, p.default, (v) =>
                update(i, { default: v }),
              )}
            </div>
            {p.type === "int" && (
              <>
                <div className="frow">
                  {bi("最小值", "Minimum")}
                  <InputNumber
                    value={p.min}
                    onChange={(min) => update(i, { min })}
                  />
                </div>
                <div className="frow">
                  {bi("最大值", "Maximum")}
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
                <span>{bi("保存值", "Stored Value")}</span>
                <span>{bi("显示名称", "Display Label")}</span>
                <span>{bi("操作", "Action")}</span>
              </div>
              {(p.options || []).map((o, j) => (
                <div key={j} className="pp-option">
                  <Input
                    aria-label={bi("选项值", "Option value")}
                    value={o.value}
                    placeholder={bi("保存的值", "Stored value")}
                    onChange={(value) =>
                      update(i, {
                        options: p.options!.map((x, k) =>
                          k === j ? { ...x, value } : x,
                        ),
                      })
                    }
                  />
                  <Input
                    aria-label={bi("选项名称", "Option label")}
                    value={o.label}
                    placeholder={bi("用户看到的名称", "Label shown to users")}
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
                    aria-label={bi("删除选项 ", "Delete option ") + (j + 1)}
                    onClick={() =>
                      update(i, {
                        options: p.options!.filter((_, k) => k !== j),
                      })
                    }
                  >
                    {bi("删除", "Delete")}
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
                {bi("添加选项", "Add option")}
              </Button>
            </div>
          )}
          <div className="frow">
            {bi("填写说明", "Help Text")}
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
        {bi("添加公共参数", "Add Platform Parameter")}
      </Button>
      <div>
        <h2>{bi("联动与校验规则", "Dependency & Validation Rules")}</h2>
        <p className="muted">
          {bi(
            "条件满足时检查要求值。隐藏字段会在用户切换选项时自动改为要求值；接口提交的冲突值仍会报错。规则不会执行脚本。",
            "Checks required values when conditions match. Hidden fields auto-update to the required value on toggle; conflicting API submissions still fail. Rules never execute scripts.",
          )}
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
              <strong>{bi(`规则 ${i + 1}`, `Rule ${i + 1}`)}</strong>
              <span className="muted">{r.id || bi("未命名", "Untitled")}</span>
            </div>
            {(r.hide || []).includes("initialize") &&
              (r.require || []).some(
                (v) => v.field === "initialize" && v.equals === true,
              ) && (
                <div className="pp-rule-error" role="alert">
                  {bi(
                    "初始化磁盘不能在隐藏后自动开启。请将下方“初始化磁盘”的要求值改为“关闭”，或移除对它的隐藏设置。",
                    "Initialize disk cannot auto-enable while hidden. Set the required value of \"Initialize Disk\" below to \"Off\", or remove it from hidden fields.",
                  )}
                </div>
              )}
            <div className="frow">
              {bi("规则标识", "Rule ID")}
              <Input value={r.id} onChange={(id) => updateRule({ id })} />
            </div>
            <strong>{bi("当以下字段等于", "When field equals")}</strong>
            {condition(r.when, (when) => updateRule({ when }))}
            <strong>{bi("必须满足", "Must satisfy")}</strong>
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
                  {bi("移除条件", "Remove condition")}
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
              {bi("添加要求", "Add requirement")}
            </Button>
            <div className="frow">
              {bi("隐藏并自动设置的字段", "Hide & auto-set fields")}
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
              {bi("冲突提示", "Conflict Message")}
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
              {bi("删除规则", "Delete rule")}
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
        {bi("添加规则", "Add Rule")}
      </Button>
    </div>
  );
}
