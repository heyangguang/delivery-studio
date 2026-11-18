import { useEffect, useRef, useState } from "react";
import { Button } from "@arco-design/web-react";
import {
  IconArrowLeft,
  IconBulb,
  IconCode,
  IconPlus,
} from "@arco-design/web-react/icon";
import type { Session } from "./shared";
import { can } from "./shared";
import { go } from "./router";
import { NewComponentModal } from "./wbdialogs";
import "./workbench.css";

const Code = ({ file, children }: { file?: string; children: string }) => (
  <figure className="wg-code">
    {file && <figcaption className="mono">{file}</figcaption>}
    <pre className="mono">{children}</pre>
  </figure>
);

const Step = ({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) => (
  <li className="wg-step">
    <span className="wg-n">{n}</span>
    <div>
      <b>{title}</b>
      <div>{children}</div>
    </div>
  </li>
);

const TOC = [
  ["parts", "一个组件由什么组成"],
  ["who", "谁来写什么"],
  ["role-files", "角色任务文件是什么"],
  ["verify", "验证怎么做"],
  ["flow", "修改的流程"],
  ["t1", "教程一：改一个默认值"],
  ["t2", "教程二：给 etcd 加一个版本"],
  ["t3", "教程三：做一个 Redis 风格的新组件"],
];

export function GuidePage({ me }: { me: Session }) {
  const admin = can("component.edit");
  const [create, setCreate] = useState(false);
  const [active, setActive] = useState("parts");
  const lock = useRef(0);
  // the contents follows the section that is on screen
  useEffect(() => {
    let raf = 0;

    const findScrollParent = (el: HTMLElement): HTMLElement | null => {
      let p = el.parentElement;
      while (
        p &&
        !(
          /(auto|scroll)/.test(getComputedStyle(p).overflowY) &&
          p.scrollHeight > p.clientHeight + 1
        )
      ) {
        p = p.parentElement;
      }
      return p || (document.scrollingElement as HTMLElement | null);
    };

    const compute = () => {
      if (Date.now() < lock.current) return;
      const els = TOC.map(([id]) => document.getElementById(id)).filter(
        Boolean,
      ) as HTMLElement[];
      if (!els.length) return;

      const sc = findScrollParent(els[0]);
      const isDoc =
        !sc ||
        sc === document.scrollingElement ||
        sc === document.documentElement ||
        sc === document.body;
      const viewTop = isDoc ? 0 : sc.getBoundingClientRect().top;
      const viewH = isDoc ? window.innerHeight : sc.clientHeight;
      const scrollTop = isDoc ? window.scrollY : sc.scrollTop;
      const maxScroll = sc ? Math.max(0, sc.scrollHeight - viewH) : 0;
      const remaining = Math.max(0, maxScroll - scrollTop);

      if (maxScroll > 2 && remaining <= 6) {
        setActive(els[els.length - 1].id);
        return;
      }

      const baseOffset = Math.min(104, viewH * 0.2);
      const bottomOffset = Math.max(baseOffset, viewH - 24);
      const tailSpan =
        maxScroll > 2 ? Math.min(maxScroll, Math.max(180, viewH * 0.6)) : 0;
      const tailProgress =
        tailSpan > 0 ? Math.max(0, Math.min(1, 1 - remaining / tailSpan)) : 0;
      const anchorY =
        viewTop + baseOffset + tailProgress * (bottomOffset - baseOffset);

      let chosen = els[0];
      for (const el of els) {
        if (el.getBoundingClientRect().top <= anchorY) chosen = el;
      }
      setActive(chosen.id);
    };

    const schedule = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        compute();
      });
    };

    compute();
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      if (raf) window.cancelAnimationFrame(raf);
      window.removeEventListener("scroll", schedule, { capture: true });
      window.removeEventListener("resize", schedule);
    };
  }, []);
  const jump = (id: string) => {
    lock.current = Date.now() + 700;
    setActive(id);
    document
      .getElementById(id)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  return (
    <div className="wg enter">
      <Button
        type="text"
        className="wb-back"
        icon={<IconArrowLeft />}
        onClick={() => go({ name: "components" })}
      >
        组件
      </Button>
      <div className="wg-layout">
        <nav className="wg-toc" aria-label="目录">
          {TOC.map(([id, t]) => (
            <a
              key={id}
              href={`#/components/guide`}
              className={active === id ? "on" : ""}
              aria-current={active === id ? "location" : undefined}
              onClick={(e) => {
                e.preventDefault();
                jump(id);
              }}
            >
              {t}
            </a>
          ))}
        </nav>
        <article className="wg-main">
          <header className="wg-hero">
            <span className="wg-eyebrow">组件工作台指南</span>
            <h1>怎么编写和修改组件</h1>
            <p className="wg-lead">
              平台本身不认识任何中间件。etcd、HAProxy、PostgreSQL
              的一切——参数、装什么包、怎么起、怎么验收——都写在各自的「组件」里。想改默认值、加一个软件版本、接入一个新中间件，都是在工作台里改组件，不需要改平台。
            </p>
            <div className="wg-flow" aria-label="组件如何变成交付">
              <div className="wg-flow-src">
                <b>你写的组件</b>
                <span>声明 · 任务 · 模板 · 测试</span>
              </div>
              <i aria-hidden>→</i>
              <div className="wg-flow-mid">
                <b>平台</b>
                <span>校验、拼装、离线打包</span>
              </div>
              <i aria-hidden>→</i>
              <div className="wg-flow-out">
                <span>部署表单</span>
                <span>Ansible 脚本</span>
                <span>部署与测试手册</span>
              </div>
            </div>
            <div className="wg-quick">
              <a
                href="#/components/guide"
                onClick={(e) => {
                  e.preventDefault();
                  jump("t1");
                }}
              >
                <IconCode />
                <b>改一个默认值</b>
                <span>约 5 分钟 · 最常用</span>
              </a>
              <a
                href="#/components/guide"
                onClick={(e) => {
                  e.preventDefault();
                  jump("t2");
                }}
              >
                <IconPlus />
                <b>给组件加一个版本</b>
                <span>先让软件库有这个包</span>
              </a>
              <a
                href="#/components/guide"
                onClick={(e) => {
                  e.preventDefault();
                  jump("t3");
                }}
              >
                <IconBulb />
                <b>做一个新组件</b>
                <span>从模板开始，一步步来</span>
              </a>
            </div>
            <div className="row-gap">
              {admin && (
                <Button type="primary" onClick={() => setCreate(true)}>
                  新建组件
                </Button>
              )}
              <Button onClick={() => go({ name: "components" })}>
                回到组件列表
              </Button>
            </div>
          </header>

          <section id="parts">
            <h2>一个组件由什么组成</h2>
            <div className="wg-parts">
              <div>
                <b className="mono">component.yaml</b>
                <p>
                  <em>声明</em>
                  ：叫什么、有哪些版本、装哪些包、有哪些参数和校验、角色和依赖、部署分几步、怎么测。平台读它生成表单、校验、部署手册和
                  Ansible 脚本。
                </p>
              </div>
              <div>
                <b className="mono">roles/&lt;角色&gt;/tasks/*.yml</b>
                <p>
                  <em>在机器上做的事</em>：写成 Ansible
                  任务，每个文件对应部署里的一步（安装、配置、启动、检查……）。
                </p>
              </div>
              <div>
                <b className="mono">templates/ 与 roles/…/templates/</b>
                <p>
                  <em>配置文件模板</em>：.j2 文件，里面用{" "}
                  <code>{"{{ mw.params.xxx }}"}</code>{" "}
                  引用参数，部署时渲染成目标机器上的配置。
                </p>
              </div>
              <div>
                <b className="mono">files/</b>
                <p>
                  <em>原样复制</em>的文件，如脚本、固定的配置片段。
                </p>
              </div>
            </div>
          </section>

          <section id="who">
            <h2>谁来写什么</h2>
            <table className="wg-table">
              <thead>
                <tr>
                  <th>部分</th>
                  <th>谁写</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>通用步骤：预检、数据盘、离线软件源、装包、密钥</td>
                  <td>平台已经做好</td>
                  <td>
                    所有组件共用。装包就是一行{" "}
                    <code>include_role: mw_packages</code>，不用关心离线源。
                  </td>
                </tr>
                <tr>
                  <td>component.yaml</td>
                  <td>了解这个中间件的人</td>
                  <td>
                    在工作台里用表单填，不必手写 YAML；高级用法在「源码」页签。
                  </td>
                </tr>
                <tr>
                  <td>任务文件与模板</td>
                  <td>了解这个中间件的人</td>
                  <td>
                    只有懂它怎么配置、怎么启动的人写得对。简单的步骤可以不写文件，直接在步骤里「直接写任务」。
                  </td>
                </tr>
                <tr>
                  <td>验证（功能测试）</td>
                  <td>了解这个中间件的人</td>
                  <td>
                    每个中间件怎么算「好了」都不一样，所以测试是各组件自己声明的。
                  </td>
                </tr>
              </tbody>
            </table>
          </section>

          <section id="role-files">
            <h2>角色任务文件是什么</h2>
            <p>
              以 etcd 为例。<code>component.yaml</code> 里「启动」阶段有一步：
            </p>
            <Code file="component.yaml">{`lifecycle:
  start:
    - id: start
      title: 启动 etcd 成员
      effect: change
      run: {role: etcd, tasks: start}`}</Code>
            <p>
              <code>run</code> 指向 <code>roles/etcd/tasks/start.yml</code>
              ——真正在每台机器上执行的就是这个文件：
            </p>
            <Code file="roles/etcd/tasks/start.yml">{`- name: 启动 etcd
  ansible.builtin.systemd:
    name: etcd
    enabled: true
    state: started

- name: 等待客户端端口
  ansible.builtin.wait_for:
    host: "{{ mw_hosts[inventory_hostname].ip }}"
    port: "{{ mw.params.client_port }}"
    timeout: 120`}</Code>
            <p>
              所以：
              <b>
                YAML
                描述「分哪几步、每步叫什么、影响多大」，任务文件写「这一步具体做什么」
              </b>
              。部署手册和 playbook 都由平台按 YAML 生成，二者不会对不上。
            </p>
            <p>
              任务文件里能用哪些变量？在工作台的「文件」页签，编辑器上方的
              <b>变量速查</b>
              会按这个组件的参数、角色、密钥列出来。配置模板还可以点
              <b>渲染预览</b>，让 Ansible 用样例机器真的渲染一遍。
            </p>
            <p>
              如果一步很简单（比如只是 <code>systemctl reload</code>
              ），不必建文件：步骤里选「直接写任务」，用表单挑模块、填参数。出于安全，直接写的任务只允许内置的安全模块，不能用{" "}
              <code>shell</code>。
            </p>
          </section>

          <section id="verify">
            <h2>验证怎么做</h2>
            <p>
              部署完成后交给人执行的验收，写在 <code>tests</code>{" "}
              里，每条是一个步骤，既会生成独立的
              playbook，也会进入「功能测试」手册。每个中间件的标准不同，所以由组件自己定义，例如
              etcd 的两条：
            </p>
            <Code file="component.yaml">{`tests:
  - id: health
    title: 集群健康与领导者
    effect: read-only
    expect: 全部端点 healthy，恰好一个 leader。
    run: {role: etcd, tasks: test_health}
  - id: put-get
    title: 写入读取删除
    effect: change
    expect: 读回的值与写入一致，测试键已删除。
    run: {role: etcd, tasks: test_put_get}`}</Code>
            <p>
              <code>effect</code> 说明这条测试会不会改东西（只读 /
              会修改……），手册会据此提醒执行者；<code>expect</code>{" "}
              写「成功是什么样」。同样可以用「直接写任务」做简单检查，比如连一下端口。
            </p>
            <p className="wg-note">
              工作台里的「试生成」只能证明<b>生成的脚本结构正确</b>（并让
              Ansible
              做语法检查），不能证明脚本在真实机器上跑得通。版本状态因此分三档：草稿
              → 待验证 →
              已发布；只有在空环境里真正部署并跑通测试后，才应标「已发布」。
            </p>
          </section>

          <section id="flow">
            <h2>修改的流程</h2>
            <ol className="wg-steps">
              <Step n={1} title="开一份草稿">
                内置组件不能直接改：在组件页点「修改…」（改动存成你自己的版本，组件会标上「已修改」，随时可以恢复内置）或「复制为自定义组件」。自定义组件点「编辑」。
              </Step>
              <Step n={2} title="改，自动保存">
                在各页签用表单改，或在「文件」「源码」里改文本，两边实时同步。草稿自动保存，发布之前不影响任何交付。
              </Step>
              <Step n={3} title="检查与试生成">
                右上角「检查」显示哪里有错，点开可跳到对应行；「试生成」按草稿生成一套样例交付，给你看表单、步骤、手册，以及和已发布版本的差异。
              </Step>
              <Step n={4} title="发布">
                写一句修订说明发布。之后新建的交付用新内容；已生成的交付不变。每次发布保存为一个修订，可以对照，也可以回到任何一个。
              </Step>
            </ol>
          </section>

          <section id="t1">
            <h2>教程一：改一个默认值</h2>
            <p className="muted">
              例：把 etcd 的心跳间隔默认值从 100 ms 改成 200 ms。约 5 分钟。
            </p>
            <ol className="wg-steps">
              <Step n={1} title="打开 etcd，点修改">
                组件页选 etcd，点「修改…」，再点「修改这个组件」。
              </Step>
              <Step n={2} title="改参数">
                进入「参数」页签，展开「心跳间隔」，把「默认值」改成{" "}
                <code>200</code>。注意旁边的「最小 /
                最大」：默认值必须在范围里，否则右上角会立刻提示。
              </Step>
              <Step n={3} title="试生成，确认改了什么">
                点「试生成」→「文件与差异」，能看到生成的{" "}
                <code>inventory/group_vars/all.yml</code> 里心跳间隔从 100 变成
                200，其他文件没有变化。
              </Step>
              <Step n={4} title="发布">
                点「发布…」，说明写「心跳默认改 200ms」。以后新建的 etcd
                交付默认就是 200。想回到原样？组件页点「恢复内置」。
              </Step>
            </ol>
            {admin && (
              <Button onClick={() => go({ name: "components", id: "etcd" })}>
                去打开 etcd
              </Button>
            )}
          </section>

          <section id="t2">
            <h2>教程二：给 etcd 加一个版本</h2>
            <p className="muted">
              例：etcd 有了新的 3.6 版本，要让它也能部署。
            </p>
            <ol className="wg-steps">
              <Step n={1} title="先让软件库有这个版本">
                去「软件库」，搜索 etcd-server，选 3.6
                的那个版本，看依赖，下载到本地。这样才能生成离线交付。
              </Step>
              <Step n={2} title="开草稿，添加版本">
                进入「版本」页签，点「添加版本」：版本号 <code>3.6</code>
                ，「继承自」选 <code>3.5</code>——这样只需写和 3.5 不同的地方。
              </Step>
              <Step n={3} title="选软件包">
                在新版本里点「从软件库选择」，搜 etcd-server 和
                etcd-client，各选刚下载的那个版本。包的版本必须与库里完全一致。
              </Step>
              <Step n={4} title="状态先保持「草稿」">
                新版本没在空环境验证过之前，状态写「草稿」或「待验证」，用它生成交付时平台会提示「不要用于生产」。
              </Step>
              <Step n={5} title="试生成选 3.6，再发布">
                「试生成」里把版本切到
                3.6，确认能生成；发布。在空环境真正部署并通过测试后，再回来把状态改为「已发布」。
              </Step>
            </ol>
          </section>

          <section id="t3">
            <h2>教程三：做一个 Redis 风格的新组件</h2>
            <p className="muted">
              例：主从结构的缓存，一个主节点加若干从节点。
            </p>
            <ol className="wg-steps">
              <Step n={1} title="用模板新建">
                组件页点「新建」，选「主从」模板，填组件名 <code>my-redis</code>
                、软件包名 <code>redis-server</code>、服务名{" "}
                <code>redis-server</code>、端口 <code>6379</code>
                。得到的是一个能直接走完流程的最小组件：装包、写配置、起服务、查端口。
              </Step>
              <Step n={2} title="选真实的软件包版本">
                模板里的版本号是占位符。到「版本」页签，点「从软件库选择」搜
                redis-server，选一个版本。
              </Step>
              <Step n={3} title="改配置模板">
                「文件」页签打开{" "}
                <code>roles/my-redis/templates/my-redis.conf.j2</code>，写成
                Redis 真正需要的配置。从节点的 <code>replicaof</code>{" "}
                已经由模板按角色写好；点「渲染预览」，选「机器」为 host2
                看从节点渲染出来的内容。
              </Step>
              <Step n={4} title="加参数">
                「参数」页签添加 <code>maxmemory</code>、
                <code>requirepass</code> 等，在模板里用{" "}
                <code>{"{{ mw.params.maxmemory }}"}</code>{" "}
                引用。密码类的放进「入口与密钥」的密钥，让平台自动生成，用{" "}
                <code>{"{{ mw.secrets.redis_password }}"}</code> 取。
              </Step>
              <Step n={5} title="写这个中间件自己的验证">
                「测试与清理」页签添加测试，选「直接写任务」：用{" "}
                <code>command</code> 模块跑{" "}
                <code>redis-cli -p {"{{ mw.params.port }}"} ping</code>
                ，更多选项里「何时算有改动」填 <code>false</code>，再加一个{" "}
                <code>assert</code> 断言返回 PONG。
              </Step>
              <Step n={6} title="试生成，检查，发布">
                「试生成」选「一主一从」方案，看拓扑图里有复制箭头、手册里的步骤是否合理；「检查」全绿后发布。真实机器上跑通之前，版本状态保持「草稿」。
              </Step>
            </ol>
            {admin && (
              <Button type="primary" onClick={() => setCreate(true)}>
                现在就试试
              </Button>
            )}
          </section>
        </article>
      </div>
      <NewComponentModal open={create} close={() => setCreate(false)} />
    </div>
  );
}
