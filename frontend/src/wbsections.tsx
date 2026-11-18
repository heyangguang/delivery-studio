import { useEffect, useRef, useState } from "react";
import { Button, Input, Modal, Select, Spin } from "@arco-design/web-react";
import { IconPlus, IconSearch } from "@arco-design/web-react/icon";
import { stringify, parse } from "yaml";
import { api } from "./shared";
import type { SearchHit, VersionDetail } from "./shared";
import {
  aiTouched,
  get,
  itemFlags,
  problemsFor,
  setValue,
  useWb,
} from "./wbdoc";
import type { Path } from "./wbdoc";
import { Fields, ListEditor, MapEditor, Section } from "./wbforms";
import { StylePicker } from "./wbstyle";
import type { FieldSpec } from "./wbforms";

const EFFECTS = [
  { value: "read-only", label: "只读（不改任何东西）" },
  { value: "change", label: "会修改" },
  { value: "disruptive", label: "会中断服务" },
  { value: "destructive", label: "会删除数据" },
];
export { EFFECTS };

const roleOpts = (roles: string[]) =>
  roles.map((r) => ({ value: r, label: r }));

/* ------------------------------------------------------------------ scope */

/** Overlay tabs edit the base component or one version's additions. The path is the same shape either way. */
export function useScope() {
  const { versions } = useWb();
  const [idx, setIdx] = useState(-1);
  const base: Path = idx < 0 ? [] : ["versions", idx];
  const bar = (
    <div className="wb-scope">
      <span>作用范围</span>
      <Select
        size="small"
        value={idx}
        onChange={setIdx}
        options={[
          { value: -1, label: "全部版本（基础）" },
          ...versions.map((v, i) => ({ value: i, label: `仅 ${v} 版` })),
        ]}
        style={{ width: 170 }}
        aria-label="作用范围"
      />
      <em>
        {idx < 0
          ? "这里写的内容对每个版本都生效"
          : "只对这个版本追加，同 id/key 的条目会覆盖基础里的"}
      </em>
    </div>
  );
  return { base, bar, idx };
}

const flagCount =
  (
    problems: ReturnType<typeof useWb>["problems"],
    _base: Path,
    section: string,
    key: (item: any) => string,
  ) =>
  (item: any) =>
    itemFlags(problems, [section], key(item));

/* ------------------------------------------------------------------ overview */

const NAMED: FieldSpec[] = [
  { key: "name", label: "名称", kind: "text", width: "s" },
  { key: "text", label: "说明", kind: "text", width: "l" },
];

export function OverviewTab() {
  const { ops } = useWb();
  const js = ops.js;
  return (
    <>
      <Section title="基本信息" help="显示在组件列表、应用商店和交付手册里。">
        <div className="wb-ident">
          <span>组件名</span>
          <b className="mono">{js.component}</b>
          <em>
            组件名是它的身份，不能在草稿里改；想要另一个名字请「复制为新组件」。
          </em>
        </div>
        <Fields
          path={[]}
          item={js}
          specs={[
            {
              key: "title",
              label: "显示名称",
              kind: "text",
              required: true,
              width: "m",
            },
            {
              key: "category",
              label: "分类",
              kind: "text",
              required: true,
              width: "m",
              hint: "同分类的组件会放在一起，如 数据库、协调服务、负载均衡",
            },
            {
              key: "short",
              label: "默认实例名",
              kind: "mono",
              width: "s",
              hint: "新建集群时默认给实例起的名字",
            },
            {
              key: "data_volume",
              label: "数据放在 /data",
              kind: "bool",
              width: "s",
            },
            { key: "summary", label: "一句话简介", kind: "area", width: "l" },
            { key: "tags", label: "标签", kind: "tags", width: "m" },
            {
              key: "provides",
              label: "提供的能力",
              kind: "tags",
              width: "m",
              hint: "别的组件用 requires 引用它，如 dcs、l4-lb",
            },
          ]}
        />
      </Section>
      <Section
        title="标识"
        help="列表、应用页和交付里显示的图标与颜色。不选就按分类使用默认的。"
      >
        <StylePicker
          id={js.component || "c"}
          category={js.category}
          icon={js.icon}
          color={js.color}
          onChange={(i, c) =>
            ops.batch((d) => {
              setValue(d, ["icon"], i || undefined);
              setValue(d, ["color"], c || undefined);
            })
          }
        />
      </Section>
      <Section title="交付能力" help="同一组件可以同时支持多种交付方式。发布时会再次核对，发布本身不会执行任何命令。">
        <Fields path={[]} item={{...js,kind:js.kind||"",delivery_modes:js.delivery_modes||(js.kind==="external"?["configuration"]:["offline"])}} specs={[
          {key:"delivery_modes",label:"支持的方式",kind:"multi",width:"l",options:[{value:"offline",label:"离线部署"},{value:"automatic",label:"自动执行"},{value:"configuration",label:"仅出配置"}],hint:"自动执行需为每一步填写超时、完成条件和判据；仅出配置需定义下方的配置文件。"},
          {key:"kind",label:"服务由谁管理",kind:"select",width:"l",options:[{value:"",label:"平台部署的软件"},{value:"external",label:"由现场管理员配置的外部服务"}]}
        ]}/>
        <h3 className="wb-sub">配置文件</h3>
        <p className="muted small">仅出配置时，按实例和机器分别生成文件。内容支持参数、集群和机器占位符，不执行脚本。</p>
        <ListEditor path={["configuration"]} noun="配置文件" fields={[
          {key:"path",label:"输出文件名",kind:"mono",width:"l",required:true,placeholder:"redis.conf"},
          {key:"content",label:"配置内容",kind:"area",width:"l",required:true,hint:"支持 ${cluster}、${instance}、${params.参数键}、${host.name}、${host.ip}、${host.data_root}。"}
        ]} head={x=>({title:x.path||"未命名配置文件"})} blank={()=>({path:"",content:""})}/>
      </Section>
      <Section title="产品页" help="只用于展示，不影响生成。">
        <Fields
          path={["detail"]}
          item={js.detail || {}}
          specs={[
            { key: "tagline", label: "标语", kind: "text", width: "l" },
            {
              key: "scale",
              label: "规模",
              kind: "text",
              width: "m",
              placeholder: "如 1–7 台",
            },
            {
              key: "limits",
              label: "当前限制",
              kind: "tags",
              width: "l",
              hint: "每条一句，如「不启用自身的 TLS」",
            },
          ]}
        />
        <h3 className="wb-sub">能力</h3>
        <ListEditor
          path={["detail", "capabilities"]}
          noun="能力"
          fields={NAMED}
          head={(x) => ({ title: x.name || "（未命名）", sub: x.text })}
          blank={() => ({ name: "", text: "" })}
        />
        <h3 className="wb-sub">包含</h3>
        <ListEditor
          path={["detail", "includes"]}
          noun="内容"
          fields={NAMED}
          head={(x) => ({ title: x.name || "（未命名）", sub: x.text })}
          blank={() => ({ name: "", text: "" })}
        />
      </Section>

    </>
  );
}

export function SchemesTab() {
  const {ops} = useWb();
  const schemes: any[] = ops.js.detail?.presets || [];
  const [selected, select] = useState(0);
  const index = Math.min(selected, Math.max(0, schemes.length - 1));
  return <>
    <p className="muted">一个组件提供多个部署方案。先选择一个系列，只编辑该系列的节点、默认配置和能力；公共参数及实现文件仍由组件复用。</p>
    <div className="plans" role="tablist" aria-label="组件部署方案">
      {schemes.map((scheme, i) => <button key={scheme.id || i} role="tab" aria-selected={i === index} className={i === index ? "plan on" : "plan"} onClick={() => select(i)}>
        <strong>{scheme.name || "未命名方案"}</strong><span>{scheme.spec || scheme.id}</span>
      </button>)}
    </div>
      <Section
        title="当前部署方案"
        help="系列、节点、能力和验收共同构成方案契约。填写真实支持的能力；缺少契约或与实现不符时不能发布。"
      >
        <ListEditor
          path={["detail", "presets"]}
          noun="方案"
          visibleIndex={index}
          onAdded={select}
          defaultOpen
          idKey="id"
          fields={[
            {
              key: "id",
              label: "编号",
              kind: "mono",
              width: "s",
              required: true,
            },
            {
              key: "name",
              label: "名称",
              kind: "text",
              width: "s",
              required: true,
            },
            {
              key: "tag",
              label: "标签",
              kind: "text",
              width: "s",
              placeholder: "推荐 / 开发测试",
            },
            {
              key: "spec",
              label: "规格说明",
              kind: "text",
              width: "l",
              placeholder: "3 台 · 容忍 1 台故障",
            },
          ]}
          head={(x) => ({ title: x.name || x.id, tag: x.tag, sub: x.spec })}
          blank={() => ({ id: "plan", name: "新方案", roles: [], contract: {operations: ["deploy"]} })}
          extra={(item, p) => <PresetRoles path={p} item={item} />}
        />
      </Section>
  </>;
}

function PresetRoles({ path, item }: { path: Path; item: any }) {
  const { roles, ops, readOnly } = useWb();
  const rows: { role: string; count: number }[] = item.roles || [];
  return (
    <div className="wb-sub-block">
      <h4>各角色台数</h4>
      {rows.map((r, i) => (
        <div className="wb-map-row" key={i}>
          <Select
            disabled={readOnly}
            value={r.role}
            options={roleOpts(roles)}
            onChange={(v) => ops.set([...path, "roles", i, "role"], v)}
            aria-label="角色"
          />
          <Input
            disabled={readOnly}
            value={String(r.count ?? "")}
            onChange={(v) =>
              ops.set([...path, "roles", i, "count"], Number(v) || 0)
            }
            aria-label="台数"
          />
          {!readOnly && (
            <Button
              size="mini"
              type="text"
              status="danger"
              onClick={() => ops.remove([...path, "roles"], i)}
            >
              删除
            </Button>
          )}
        </div>
      ))}
      {!readOnly && (
        <Button
          size="mini"
          type="text"
          icon={<IconPlus />}
          onClick={() =>
            ops.add([...path, "roles"], { role: roles[0] || "", count: 1 })
          }
        >
          添加角色
        </Button>
      )}
      <h4>系列契约</h4>
      <p className="muted small">系列名称须与能力一致。验收引用格式为“组件名/测试ID”；声明测试不代表已在真实环境验收。</p>
      <label>系列类型</label>
      <Select aria-label="系列类型" disabled={readOnly} value={item.contract?.series}
        options={[{value:"basic",label:"基础系列"},{value:"replication",label:"主从系列"},{value:"ha",label:"高可用系列"},{value:"sharded",label:"分片集群系列"}]}
        onChange={(value) => {
          const names: Record<string,string> = {basic:"基础系列",replication:"主从系列",ha:"高可用系列",sharded:"分片集群系列"};
          ops.batch((doc) => {
            setValue(doc,[...path,"contract","series"],value);
            if (!item.name) setValue(doc,[...path,"name"],names[value]);
          });
        }} />
      <Fields path={[...path, "contract"]} item={item.contract || {}} specs={[
        {key:"when",label:"系列匹配条件",kind:"expr",required:true,width:"l",hint:"识别架构，不要绑定内存大小等可调配置"},
        {key:"failover",label:"故障切换",kind:"select",required:true,options:[{value:"none",label:"无切换"},{value:"manual",label:"人工切换"},{value:"automatic",label:"自动切换"}]},
        {key:"mechanism",label:"实现机制",kind:"text",required:true,width:"m",placeholder:"例如 Patroni + etcd"},
        {key:"read_access",label:"读取能力",kind:"text",required:true,width:"l",placeholder:"例如主库读写、从库只读"},
        {key:"sharding",label:"提供数据分片",kind:"bool"},
        {key:"limitations",label:"适用限制",kind:"tags",required:true,width:"l",hint:"每条写明一个实际限制"},
        {key:"acceptance",label:"验收测试",kind:"tags",required:true,width:"l",placeholder:"postgresql/native-replication"},
        {key:"operations",label:"支持操作",kind:"multi",required:true,width:"l",options:[{value:"deploy",label:"部署"}]},
      ]}/>
      <h4>本方案的参数默认值</h4>
      <p className="muted small">未单独设置的参数沿用公共定义；这里的修改只保存到当前方案。</p>
      {Object.keys(item.params || {}).map(key => {
        const def = (ops.js.params || []).find((p: any) => p.key === key);
        return <div key={key} className="wb-scheme-param">
          <Fields path={[...path,"params"]} item={item.params} specs={[{
            key, label: def?.label || key, width:"l",
            kind: def?.type === "cidr-list" ? "tags" : def?.type === "enum" ? "select" : def?.type === "bool" ? "bool" : ["int","port","float"].includes(def?.type) ? "number" : "text",
            options: (def?.options || []).map((v: string) => ({value:v,label:v})),
            hint: def?.hint, min: typeof def?.min === "number" ? def.min : undefined, max: typeof def?.max === "number" ? def.max : undefined,
          }]}/>
          {!readOnly && <Button size="mini" type="text" onClick={() => ops.set([...path,"params",key],undefined)}>恢复公共默认值</Button>}
        </div>;
      })}
      {!readOnly && <Select aria-label="添加方案参数" placeholder="选择需要单独设置的参数" value={undefined} showSearch
        options={(ops.js.params || []).filter((p: any) => !(p.key in (item.params || {}))).map((p: any) => ({value:p.key,label:p.label || p.key}))}
        onChange={(key) => {const def=(ops.js.params || []).find((p: any) => p.key===key);ops.batch(doc => doc.setIn([...path,"params",key],doc.createNode(def?.default ?? "")));}}/>}
    </div>
  );
}

/* ------------------------------------------------------------------ versions */

const STATUS = [
  { value: "draft", label: "草稿（未验证）" },
  { value: "verifying", label: "待验证" },
  { value: "published", label: "已发布（已在空环境验证）" },
];

export function VersionsTab() {
  const { platforms, versions, problems } = useWb();
  return (
    <>
      <Section
        title="版本"
        help="一个版本就是一套可以装的软件包。后加的版本可以用「继承」只写和前一版不同的地方。"
      >
        <ListEditor
          path={["versions"]}
          noun="版本"
          idKey="id"
          defaultOpen
          flagged={(x) =>
            problemsFor(problems, (p) => p.startsWith(`versions[${x.id}]`))
              .length
          }
          fields={[
            {
              key: "id",
              label: "版本号",
              kind: "mono",
              width: "s",
              required: true,
              hint: "如 3.5、16",
            },
            {
              key: "status",
              label: "状态",
              kind: "select",
              width: "m",
              required: true,
              options: STATUS,
            },
            {
              key: "extends",
              label: "继承自",
              kind: "select",
              width: "s",
              options: (item) =>
                versions
                  .filter((v) => v !== item.id)
                  .map((v) => ({ value: v, label: v })),
            },
            {
              key: "platforms",
              label: "支持的系统",
              kind: "multi",
              width: "l",
              options: platforms.map((p) => ({ value: p.id, label: p.title })),
            },
            {
              key: "released",
              label: "发布日期",
              kind: "mono",
              width: "s",
              hint: "如 2026-10-01",
            },
            {
              key: "notes",
              label: "这个版本带来了什么",
              kind: "tags",
              width: "l",
              hint: "每条一句，选型时展示给用户",
            },
          ]}
          head={(x) => ({
            title: <span className="mono">{x.id}</span>,
            tag: STATUS.find((s) => s.value === x.status)?.label.split("（")[0],
            sub: `${(x.packages || []).length} 个软件包${x.extends ? ` · 继承 ${x.extends}` : ""}`,
          })}
          blank={() => ({
            id: "1.0",
            status: "draft",
            platforms: platforms.slice(0, 1).map((p) => p.id),
            packages: [],
          })}
          extra={(item, p) => <VersionExtra item={item} path={p} />}
        />
      </Section>
      <p className="wb-note">
        版本里还可以追加参数、步骤、测试等：到对应的页签，把「作用范围」切到这个版本。
      </p>
    </>
  );
}

function VersionExtra({ item, path }: { item: any; path: Path }) {
  const { ops, readOnly, platforms } = useWb();
  const pkgs: any[] = item.packages || [];
  const [pick, setPick] = useState(false);
  return (
    <>
      <div className="wb-sub-block">
        <h4>
          软件包
          <span>
            版本必须与软件库里的完全一致；这些包连同依赖会随交付一起带走。
          </span>
        </h4>
        {pkgs.map((pk, i) => (
          <div className="wb-pkg-row" key={i}>
            <Input
              disabled={readOnly}
              className="wb-mono"
              value={pk.name ?? ""}
              placeholder="包名"
              onChange={(v) => ops.set([...path, "packages", i, "name"], v)}
              aria-label="包名"
            />
            <Input
              disabled={readOnly}
              className="wb-mono"
              value={pk.version ?? ""}
              placeholder="版本"
              onChange={(v) => ops.set([...path, "packages", i, "version"], v)}
              aria-label="包版本"
            />
            <Input
              disabled={readOnly}
              className="wb-mono"
              value={pk.when ?? ""}
              placeholder="条件（可选）"
              onChange={(v) => ops.set([...path, "packages", i, "when"], v)}
              aria-label="条件"
            />
            {!readOnly && (
              <Button
                size="mini"
                type="text"
                status="danger"
                onClick={() => ops.remove([...path, "packages"], i)}
              >
                删除
              </Button>
            )}
          </div>
        ))}
        {!readOnly && (
          <div className="wb-row-gap">
            <Button
              size="small"
              type="outline"
              icon={<IconSearch />}
              onClick={() => setPick(true)}
            >
              从软件库选择
            </Button>
            <Button
              size="small"
              type="text"
              icon={<IconPlus />}
              onClick={() =>
                ops.add([...path, "packages"], { name: "", version: "" })
              }
            >
              手动添加
            </Button>
          </div>
        )}
      </div>
      <div className="wb-sub-block">
        <h4>
          离线文件
          <span>不是软件包的文件（安装包、证书等），放在平台的材料库里。</span>
        </h4>
        <ListEditor
          path={[...path, "artifacts"]}
          noun="文件"
          fields={[
            { key: "name", label: "名称", kind: "mono", width: "s" },
            {
              key: "kind",
              label: "类型",
              kind: "text",
              width: "s",
              placeholder: "file",
            },
            { key: "file", label: "文件名", kind: "mono", width: "m" },
            { key: "sha256", label: "SHA256", kind: "mono", width: "l" },
            { key: "when", label: "条件", kind: "expr", width: "l" },
          ]}
          head={(x) => ({ title: x.name || "（未命名）", sub: x.file })}
          blank={() => ({ name: "", kind: "file", file: "" })}
        />
      </div>
      <PackagePicker
        open={pick}
        close={() => setPick(false)}
        platform={
          (item.platforms && item.platforms[0]) ||
          platforms[0]?.id ||
          "ubuntu-24.04-amd64"
        }
        platformIds={platforms.map((p) => p.id)}
        onPick={(name, version) => {
          // choosing a package that is already listed (a template's placeholder) sets its version instead of adding another
          const at = pkgs.findIndex((x) => x.name === name);
          if (at >= 0) ops.set([...path, "packages", at, "version"], version);
          else ops.add([...path, "packages"], { name, version });
          setPick(false);
        }}
      />
    </>
  );
}

/** Find a package and one of its versions in the package library's source index. */
function PackagePicker({
  open,
  close,
  platform,
  platformIds,
  onPick,
}: {
  open: boolean;
  close: () => void;
  platform: string;
  platformIds: string[];
  onPick: (n: string, v: string) => void;
}) {
  const [plat, setPlat] = useState(platform);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [chosen, setChosen] = useState<SearchHit | null>(null);
  const [versions, setVersions] = useState<VersionDetail[] | null>(null);
  const [error, setError] = useState("");
  const seq = useRef(0);
  useEffect(() => {
    if (open) setPlat(platform);
  }, [open, platform]);
  useEffect(() => {
    const term = q.trim();
    setChosen(null);
    setVersions(null);
    if (term.length < 2) {
      setHits(null);
      setError("");
      return;
    }
    const n = ++seq.current;
    const t = setTimeout(() => {
      api<{ hits: SearchHit[] }>(
        `/api/library/search?platform=${encodeURIComponent(plat)}&q=${encodeURIComponent(term)}`,
      )
        .then((r) => n === seq.current && (setHits(r.hits), setError("")))
        .catch(
          (e) =>
            n === seq.current && (setHits([]), setError((e as Error).message)),
        );
    }, 200);
    return () => clearTimeout(t);
  }, [q, plat]);
  const choose = (h: SearchHit) => {
    setChosen(h);
    setVersions(null);
    api<{ details: VersionDetail[] }>(
      `/api/library/versions?platform=${encodeURIComponent(plat)}&package=${encodeURIComponent(h.name)}`,
    )
      .then((r) => setVersions(r.details))
      .catch((e) => setError((e as Error).message));
  };
  return (
    <Modal
      visible={open}
      onCancel={close}
      footer={null}
      title="从软件库选择软件包"
      style={{ width: 640, maxWidth: "94vw" }}
    >
      <div className="wb-pick">
        <div className="wb-pick-bar">
          <Select
            size="default"
            value={plat}
            onChange={setPlat}
            options={platformIds.map((p) => ({ value: p, label: p }))}
            style={{ width: 190 }}
            aria-label="系统"
          />
          <Input
            allowClear
            autoFocus
            prefix={<IconSearch />}
            placeholder="搜索软件包，如 redis、etcd"
            value={q}
            onChange={setQ}
            aria-label="搜索软件包"
          />
        </div>
        {error && <p className="bad small">{error}</p>}
        <div className="wb-pick-cols">
          <div className="wb-pick-list" role="listbox" aria-label="搜索结果">
            {hits === null && !error && (
              <p className="muted small">
                输入至少两个字符。搜索用的是软件库里的源索引，不需要联网。
              </p>
            )}
            {hits?.length === 0 && !error && (
              <p className="muted small">没有匹配的软件包</p>
            )}
            {hits?.map((h) => (
              <button
                type="button"
                key={h.name}
                role="option"
                aria-selected={chosen?.name === h.name}
                className={chosen?.name === h.name ? "on" : ""}
                onClick={() => choose(h)}
              >
                <b className="mono">{h.name}</b>
                <span>
                  最新 {h.latest} · {h.versions} 个版本
                </span>
              </button>
            ))}
          </div>
          <div className="wb-pick-list">
            {!chosen && (
              <p className="muted small">选择左边的软件包，再选一个版本。</p>
            )}
            {chosen && !versions && <Spin />}
            {versions?.map((v) => (
              <button
                type="button"
                key={v.version}
                onClick={() => onPick(chosen!.name, v.version)}
              >
                <b className="mono">{v.version}</b>
                <span>
                  {v.suite}
                  {v.have ? " · 已在库" : ""}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ parameters */

const TYPES = [
  "int",
  "float",
  "bool",
  "enum",
  "string",
  "size",
  "port",
  "cidr",
  "cidr-list",
  "ip",
  "host",
].map((v) => ({ value: v, label: v }));

export function ParamsTab() {
  const { problems, groups, roles } = useWb();
  const { base, bar } = useScope();
  const flag = (section: string, key: (x: any) => string) =>
    flagCount(problems, base, section, key);
  return (
    <>
      {bar}
      <Section title="参数分组" help="参数在表单里按分组显示。">
        <ListEditor
          path={[...base, "groups"]}
          noun="分组"
          idKey="id"
          fields={[
            {
              key: "id",
              label: "编号",
              kind: "mono",
              width: "s",
              required: true,
            },
            {
              key: "label",
              label: "显示名",
              kind: "text",
              width: "m",
              required: true,
            },
            {
              key: "scope",
              label: "范围",
              kind: "text",
              width: "s",
              hint: "留空为实例级",
            },
            { key: "tab", label: "所在页签", kind: "text", width: "s" },
          ]}
          head={(x) => ({
            title: x.label || x.id,
            sub: <span className="mono">{x.id}</span>,
          })}
          blank={() => ({ id: "group", label: "新分组" })}
        />
      </Section>
      <Section
        title="参数"
        help="使用者在新建集群时可以调的东西。类型决定了表单里用什么控件，并自动校验范围。"
      >
        <ListEditor
          path={[...base, "params"]}
          noun="参数"
          idKey="key"
          flagged={flag("params", (x) => x.key)}
          fields={PARAM_FIELDS(groups)}
          head={(x) => ({
            title: x.label || x.key,
            tag: x.type,
            sub: <span className="mono">{x.key}</span>,
          })}
          blank={() => ({
            key: "new_param",
            label: "新参数",
            type: "string",
            group: groups[0]?.id,
          })}
        />
      </Section>
      <Section
        title="校验规则"
        help="几个参数之间必须满足的关系。表达式为真才算通过；写警告则只提醒不拦截。"
      >
        <ListEditor
          path={[...base, "rules"]}
          noun="规则"
          idKey="id"
          flagged={flag("rules", (x) => x.id)}
          fields={[
            {
              key: "id",
              label: "编号",
              kind: "mono",
              width: "s",
              required: true,
            },
            { key: "warn", label: "只警告", kind: "bool", width: "s" },
            {
              key: "expr",
              label: "必须成立的表达式",
              kind: "expr",
              width: "l",
              required: true,
            },
            {
              key: "message",
              label: "不成立时的提示",
              kind: "text",
              width: "l",
              required: true,
            },
          ]}
          head={(x) => ({ title: x.id, sub: x.message })}
          blank={() => ({ id: "rule", expr: "", message: "" })}
        />
      </Section>
      <Section
        title="端口"
        help="声明占用的端口，平台据此检查同一台机器上的冲突。值可以写数字或 =params.xxx。"
      >
        <ListEditor
          path={[...base, "ports"]}
          noun="端口"
          idKey="name"
          flagged={flag("ports", (x) => x.name)}
          fields={[
            {
              key: "name",
              label: "名称",
              kind: "mono",
              width: "s",
              required: true,
            },
            {
              key: "value",
              label: "端口值",
              kind: "text",
              loose: true,
              width: "s",
              required: true,
              hint: "如 5432 或 =params.client_port",
            },
            {
              key: "proto",
              label: "协议",
              kind: "select",
              width: "s",
              options: [
                { value: "tcp", label: "tcp" },
                { value: "udp", label: "udp" },
              ],
            },
            {
              key: "roles",
              label: "哪些角色占用",
              kind: "multi",
              width: "m",
              options: roleOpts(roles),
              hint: "留空为每个角色",
            },
            { key: "when", label: "条件", kind: "expr", width: "l" },
          ]}
          head={(x) => ({
            title: x.name,
            sub: <span className="mono">{String(x.value ?? "")}</span>,
          })}
          blank={() => ({ name: "port", value: 8080 })}
        />
      </Section>
    </>
  );
}

const PARAM_FIELDS = (groups: { id: string; label: string }[]): FieldSpec[] => [
  {
    key: "key",
    label: "参数 key",
    kind: "mono",
    width: "s",
    required: true,
    hint: "小写字母、数字、下划线；roles 里用 mw.params.<key> 引用",
  },
  { key: "label", label: "显示名", kind: "text", width: "m", required: true },
  {
    key: "type",
    label: "类型",
    kind: "select",
    width: "s",
    required: true,
    options: TYPES,
  },
  {
    key: "group",
    label: "分组",
    kind: "select",
    width: "s",
    options: groups.map((g) => ({ value: g.id, label: g.label })),
  },
  {
    key: "default",
    label: "默认值",
    kind: "text",
    loose: true,
    width: "s",
    hint: "以 = 开头为表达式",
  },
  {
    key: "unit",
    label: "单位",
    kind: "text",
    width: "s",
    placeholder: "ms、MB",
  },
  {
    key: "min",
    label: "最小",
    kind: "text",
    loose: true,
    width: "s",
    show: (x) => ["int", "float", "size"].includes(x.type),
  },
  {
    key: "max",
    label: "最大",
    kind: "text",
    loose: true,
    width: "s",
    show: (x) => ["int", "float", "size"].includes(x.type),
  },
  {
    key: "options",
    label: "可选值",
    kind: "tags",
    width: "l",
    show: (x) => x.type === "enum",
  },
  {
    key: "pattern",
    label: "格式（正则）",
    kind: "mono",
    width: "m",
    show: (x) => x.type === "string",
  },
  { key: "hint", label: "提示文字", kind: "text", width: "l" },
  { key: "when", label: "仅在以下条件下显示", kind: "expr", width: "l" },
  { key: "required", label: "必填", kind: "bool", width: "s" },
  { key: "restart", label: "修改后需重启", kind: "bool", width: "s" },
  { key: "advanced", label: "高级", kind: "bool", width: "s" },
  { key: "locked", label: "锁定（由附加项推导）", kind: "bool", width: "s" },
];

/* ------------------------------------------------------------------ relations */

export function RelationsTab() {
  const { roles, problems } = useWb();
  const { base, bar } = useScope();
  const flag = (section: string, key: (x: any) => string) =>
    flagCount(problems, base, section, key);
  return (
    <>
      {bar}
      <Section
        title="角色"
        help="部署时用户给每个角色选机器。「奇数」用于需要多数派的角色；「互斥」表示同一台机器上不能同时扮演另一个互斥角色；「先行」的第一台机器先于其他机器初始化。"
      >
        <ListEditor
          path={[...base, "roles"]}
          noun="角色"
          idKey="name"
          defaultOpen
          flagged={flag("roles", (x) => x.name)}
          fields={[
            {
              key: "name",
              label: "角色名",
              kind: "mono",
              width: "s",
              required: true,
            },
            { key: "title", label: "显示名", kind: "text", width: "s" },
            {
              key: "min",
              label: "最少台数",
              kind: "number",
              width: "s",
              min: 0,
            },
            {
              key: "default",
              label: "默认台数",
              kind: "number",
              width: "s",
              min: 0,
            },
            {
              key: "max",
              label: "硬性上限",
              kind: "number",
              width: "s",
              min: 0,
              hint: "只在确实不能更多时填（如主库只能 1 台）；一般留空",
            },
            {
              key: "advise",
              label: "建议不超过",
              kind: "number",
              width: "s",
              min: 0,
              hint: "超过只提示，不阻止",
            },
            {
              key: "advise_why",
              label: "超过时提示",
              kind: "text",
              width: "l",
              show: (x) => !!x.advise,
              placeholder: "成员越多写入越慢",
            },
            {
              key: "odd",
              label: "建议奇数",
              kind: "bool",
              width: "s",
              hint: "偶数时提示：多数派不增加容错",
            },
            { key: "exclusive", label: "互斥", kind: "bool", width: "s" },
            { key: "initial", label: "先行", kind: "bool", width: "s" },
          ]}
          head={(x) => ({
            title: x.title || x.name,
            sub: <span className="mono">{x.name}</span>,
            tag: x.max
              ? x.min === x.max
                ? `固定 ${x.max} 台`
                : `${x.min ?? 0}–${x.max} 台`
              : `${x.min ?? 0} 台起`,
          })}
          blank={() => ({ name: "node", title: "节点", min: 1, default: 1 })}
        />
      </Section>
      <Section
        title="数据流"
        help="只用于画拓扑图和手册里的关系说明，不影响生成。镜像（mesh）表示同一角色的成员互相通信，复制（replication）是单向的。"
      >
        <ListEditor
          path={[...base, "flows"]}
          noun="数据流"
          idKey="id"
          flagged={flag("flows", (x) => x.id)}
          fields={[
            {
              key: "id",
              label: "编号",
              kind: "mono",
              width: "s",
              required: true,
            },
            {
              key: "title",
              label: "标题",
              kind: "text",
              width: "m",
              required: true,
            },
            {
              key: "kind",
              label: "画法",
              kind: "select",
              width: "s",
              required: true,
              options: [
                { value: "replication", label: "单向复制" },
                { value: "mesh", label: "成员互联" },
              ],
            },
            {
              key: "from",
              label: "从",
              kind: "select",
              width: "s",
              required: true,
              options: roleOpts(roles),
            },
            {
              key: "to",
              label: "到",
              kind: "select",
              width: "s",
              required: true,
              options: roleOpts(roles),
            },
            {
              key: "sync",
              label: "同步（表达式）",
              kind: "expr",
              width: "m",
              hint: "确认后才继续的写法，如 params.replication == 'quorum' 或 \"true\"",
            },
            { key: "when", label: "存在条件", kind: "expr", width: "l" },
          ]}
          head={(x) => ({
            title: x.title || x.id,
            sub: `${x.from || "?"} → ${x.to || "?"}`,
            tag: x.kind === "mesh" ? "互联" : "复制",
          })}
          blank={() => ({
            id: "flow",
            title: "数据流",
            kind: "replication",
            from: roles[0] || "",
            to: roles[1] || roles[0] || "",
          })}
        />
      </Section>
      <Section
        title="依赖"
        help="需要别的组件提供的能力。没指定提供者时，平台自动加入「默认实现」。"
      >
        <ListEditor
          path={[...base, "requires"]}
          noun="依赖"
          flagged={flag("requires", (x) => x.capability)}
          fields={[
            {
              key: "capability",
              label: "需要的能力",
              kind: "mono",
              width: "s",
              required: true,
              hint: "如 dcs、l4-lb",
            },
            {
              key: "default_impl",
              label: "默认实现（组件名）",
              kind: "mono",
              width: "s",
            },
            {
              key: "placement",
              label: "默认实现放在哪",
              kind: "select",
              width: "s",
              options: [{ value: "same_hosts", label: "同一批机器（默认）" }],
            },
            {
              key: "version",
              label: "版本要求",
              kind: "text",
              width: "s",
              placeholder: ">=3.4",
            },
            {
              key: "when",
              label: "仅在以下条件下需要",
              kind: "expr",
              width: "l",
            },
          ]}
          head={(x) => ({
            title: <span className="mono">{x.capability || "（未填）"}</span>,
            sub: x.default_impl ? `默认 ${x.default_impl}` : "必须由部署指定",
          })}
          blank={() => ({ capability: "dcs" })}
          extra={(item, p) => (
            <div className="wb-sub-block">
              <h4>
                传给默认实现的参数<span>以 = 开头为表达式</span>
              </h4>
              <MapEditor
                path={[...p, "with"]}
                value={item.with}
                keyLabel="参数 key"
              />
            </div>
          )}
        />
      </Section>
      <Section
        title="附加项（可选）"
        help="数据库扩展之类按对象挂接的增强。部署时用户按对象（例如数据库）选择要装哪些；不选对象就装进默认对象。"
      >
        <AddonsEditor path={[...base, "addons"]} />
      </Section>
    </>
  );
}

/* ------------------------------------------------------------------ endpoints */

export function EndpointsTab() {
  const { roles, problems } = useWb();
  const { base, bar } = useScope();
  const flag = (section: string, key: (x: any) => string) =>
    flagCount(problems, base, section, key);
  return (
    <>
      {bar}
      <Section
        title="对外入口"
        help="前面的负载均衡要知道往哪转发、怎么判断后端是否健康。同名入口可以按条件有几种写法（单机直连、集群走健康接口）。"
      >
        <ListEditor
          path={[...base, "endpoints"]}
          noun="入口"
          flagged={flag("endpoints", (x) => x.name)}
          fields={[
            {
              key: "name",
              label: "名称",
              kind: "mono",
              width: "s",
              required: true,
            },
            { key: "title", label: "显示名", kind: "text", width: "m" },
            {
              key: "protocol",
              label: "协议",
              kind: "select",
              width: "s",
              required: true,
              options: [
                { value: "tcp", label: "tcp" },
                { value: "http", label: "http" },
              ],
            },
            {
              key: "port",
              label: "端口",
              kind: "text",
              loose: true,
              width: "s",
              required: true,
              hint: "数字或 =params.xxx",
            },
            {
              key: "backends",
              label: "后端角色",
              kind: "multi",
              width: "m",
              required: true,
              options: roleOpts(roles),
            },
            {
              key: "lb",
              label: "能否挂负载均衡",
              kind: "select",
              width: "s",
              options: [
                { value: "allowed", label: "可以" },
                { value: "discouraged", label: "不推荐" },
                { value: "none", label: "不可以" },
              ],
            },
            { key: "when", label: "使用条件", kind: "expr", width: "l" },
            { key: "note", label: "给使用者的说明", kind: "text", width: "l" },
          ]}
          head={(x) => ({
            title: x.title || x.name,
            tag: x.protocol,
            sub: (
              <span className="mono">
                {x.name} · {String(x.port ?? "")}
              </span>
            ),
          })}
          blank={() => ({
            name: "service",
            protocol: "tcp",
            port: 8080,
            backends: [],
          })}
          extra={(item, p) => (
            <div className="wb-sub-block">
              <h4>健康检查</h4>
              <Fields
                path={[...p, "health"]}
                item={item.health || {}}
                specs={[
                  {
                    key: "type",
                    label: "方式",
                    kind: "select",
                    width: "s",
                    options: [
                      { value: "tcp", label: "tcp 连接" },
                      { value: "http", label: "http 请求" },
                      { value: "tcp-script", label: "tcp 发送/期望" },
                    ],
                  },
                  {
                    key: "port",
                    label: "端口",
                    kind: "text",
                    loose: true,
                    width: "s",
                    placeholder: "默认同入口",
                  },
                  {
                    key: "path",
                    label: "路径",
                    kind: "mono",
                    width: "s",
                    show: (h) => h.type === "http",
                  },
                  {
                    key: "status",
                    label: "期望状态码",
                    kind: "number",
                    width: "s",
                    show: (h) => h.type === "http",
                  },
                  {
                    key: "send",
                    label: "发送",
                    kind: "mono",
                    width: "m",
                    show: (h) => h.type === "tcp-script",
                  },
                  {
                    key: "expect",
                    label: "期望",
                    kind: "mono",
                    width: "m",
                    show: (h) => h.type === "tcp-script",
                  },
                ]}
              />
            </div>
          )}
        />
      </Section>
      <Section
        title="密钥"
        help="平台在控制机上自动生成并保存，roles 里用 mw.secrets.<名称> 取；长度是字符数。"
      >
        <ListEditor
          path={[...base, "secrets"]}
          noun="密钥"
          idKey="name"
          flagged={flag("secrets", (x) => x.name)}
          fields={[
            {
              key: "name",
              label: "名称",
              kind: "mono",
              width: "s",
              required: true,
            },
            {
              key: "length",
              label: "长度",
              kind: "number",
              width: "s",
              min: 8,
            },
            {
              key: "when",
              label: "仅在以下条件下生成",
              kind: "expr",
              width: "l",
            },
          ]}
          head={(x) => ({
            title: <span className="mono">{x.name}</span>,
            sub: x.length ? `${x.length} 位` : "",
          })}
          blank={() => ({ name: "password", length: 24 })}
        />
      </Section>
      <Section
        title="需要上传的文件"
        help="使用者必须提供的文件，目前支持 TLS 证书包（证书、私钥、CA）。"
      >
        <ListEditor
          path={[...base, "inputs"]}
          noun="文件"
          idKey="name"
          flagged={flag("inputs", (x) => x.name)}
          fields={[
            {
              key: "name",
              label: "名称",
              kind: "mono",
              width: "s",
              required: true,
            },
            {
              key: "label",
              label: "界面上显示",
              kind: "text",
              width: "m",
              required: true,
            },
            {
              key: "kind",
              label: "种类",
              kind: "select",
              width: "s",
              required: true,
              options: [{ value: "tls-bundle", label: "TLS 证书包" }],
            },
            {
              key: "when",
              label: "仅在以下条件下需要",
              kind: "expr",
              width: "l",
            },
          ]}
          head={(x) => ({
            title: x.label || x.name,
            sub: <span className="mono">{x.name}</span>,
          })}
          blank={() => ({ name: "tls", label: "TLS 证书", kind: "tls-bundle" })}
        />
      </Section>
      <Section
        title="负载均衡能力（可选）"
        help="只有提供 l4-lb 的组件才写：声明自己能处理的协议和健康检查方式。"
      >
        <LBEditor path={[...base, "lb"]} />
      </Section>
    </>
  );
}

/* ------------------------------------------------------------------ raw blocks */

/** A part of the manifest without its own form: a small YAML editor that writes back when it parses. */
/** What a load balancer implementation can do: the protocols it forwards and the health checks it runs. */
function LBEditor({ path }: { path: Path }) {
  const { ops } = useWb();
  const lb = get(ops.js, path) || {};
  return (
    <Fields
      path={path}
      item={lb}
      specs={[
        {
          key: "protocols",
          label: "能转发的协议",
          kind: "multi",
          width: "m",
          options: [
            { value: "tcp", label: "TCP" },
            { value: "udp", label: "UDP" },
            { value: "http", label: "HTTP" },
          ],
        },
        {
          key: "health",
          label: "支持的健康检查",
          kind: "multi",
          width: "m",
          options: [
            { value: "tcp", label: "TCP 连通" },
            { value: "http", label: "HTTP 状态" },
            { value: "tcp-script", label: "TCP 收发脚本" },
          ],
        },
      ]}
    />
  );
}

/** The add-ons a component offers (database extensions and the like): what they attach to, and each one. */
function AddonsEditor({ path }: { path: Path }) {
  const { ops } = useWb();
  const set = get(ops.js, path) || {};
  return (
    <div className="wb-addons">
      <Fields
        path={path}
        item={set}
        specs={[
          {
            key: "kind",
            label: "类型",
            kind: "mono",
            width: "s",
            placeholder: "pg-extension",
            hint: "由组件的任务文件解释，例如 pg-extension",
          },
        ]}
      />
      <Fields
        path={[...path, "scope"]}
        item={set.scope || {}}
        specs={[
          {
            key: "name",
            label: "挂接的对象",
            kind: "text",
            width: "s",
            placeholder: "database",
            hint: "部署表单里让用户选的对象，例如 database",
          },
          {
            key: "defaults",
            label: "默认对象",
            kind: "tags",
            width: "m",
            hint: "用户没有选时装进这些，例如 postgres、template1",
          },
        ]}
      />
      <ListEditor
        path={[...path, "items"]}
        noun="附加项"
        idKey="id"
        head={(x) => ({
          title: x.title || x.id || "（未命名）",
          sub: x.title ? x.id : undefined,
          tag: x.builtin ? "内置" : x.contrib ? "contrib" : undefined,
        })}
        blank={() => ({ id: "new-addon", contrib: true })}
        fields={[
          {
            key: "id",
            label: "标识",
            kind: "mono",
            width: "s",
            required: true,
          },
          { key: "title", label: "显示名", kind: "text", width: "m" },
          {
            key: "contrib",
            label: "随软件自带（contrib）",
            kind: "bool",
            width: "s",
          },
          {
            key: "builtin",
            label: "已默认启用",
            kind: "bool",
            width: "s",
          },
          {
            key: "restart",
            label: "启用后要重启",
            kind: "bool",
            width: "s",
          },
          {
            key: "since",
            label: "从哪个版本起",
            kind: "mono",
            width: "s",
          },
          { key: "until", label: "到哪个版本止", kind: "mono", width: "s" },
        ]}
        extra={(_x, p) => (
          <div className="wb-sub-block">
            <h4>
              高级
              <span>附加项自己的参数、要强制设置的实例参数、额外的离线包</span>
            </h4>
            <RawBlock path={[...p, "params"]} label="params" />
            <RawBlock path={[...p, "set_params"]} label="set_params" />
            <RawBlock path={[...p, "artifacts"]} label="artifacts" />
          </div>
        )}
      />
    </div>
  );
}

export function RawBlock({ path, label }: { path: Path; label: string }) {
  const { ops, readOnly, aiMarks } = useWb();
  const value = get(ops.js, path);
  const canon =
    value === undefined
      ? ""
      : stringify(value, { lineWidth: 0, flowCollectionPadding: false });
  const [text, setText] = useState(canon);
  const [error, setError] = useState("");
  const last = useRef(canon);
  useEffect(() => {
    if (canon !== last.current) {
      last.current = canon;
      setText(canon);
      setError("");
    }
  }, [canon]);
  const commit = () => {
    try {
      const v = text.trim() ? parse(text) : undefined;
      last.current =
        v === undefined
          ? ""
          : stringify(v, { lineWidth: 0, flowCollectionPadding: false });
      ops.set(path, v);
      setError("");
    } catch (e) {
      setError((e as Error).message.split("\n")[0]);
    }
  };
  return (
    <div
      className="wb-raw"
      data-wb={path.join(".")}
      data-wb-ai={aiTouched(aiMarks, path) ? "" : undefined}
    >
      <textarea
        className="wb-raw-text mono"
        disabled={readOnly}
        spellCheck={false}
        rows={Math.min(14, Math.max(3, text.split("\n").length + 1))}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        aria-label={`${label} 的 YAML`}
        placeholder={`${label}: 留空表示没有`}
      />
      {error && <p className="bad small">YAML 有误，未应用：{error}</p>}
    </div>
  );
}
