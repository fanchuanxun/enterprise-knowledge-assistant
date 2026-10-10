#!/usr/bin/env node
/**
 * judge.mjs 的单元测试 —— 不依赖浏览器，毫秒级完成。
 *
 * 这个文件的存在意义：判定口径是「118/118 可不可信」的全部依据。
 * 其中最容易被忽视的一条是「要点必须落在同一条证据内」——
 * 旧口径只检查整块答案面板是否包含关键词，于是「1.1 命中一个词、1.2 命中另一个词」
 * 也会被判为通过，而实际上没有任何一条证据回答了这个问题。
 * 下面 R01 就是这个场景的回归用例。
 *
 * 运行：node eval/judge-test.mjs
 */
import { judge } from './judge.mjs';

let passed = 0;
const failures = [];

function check(name, actual, expected) {
  if (actual === expected) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failures.push(`${name}（期望 ${expected}，实际 ${actual}）`);
    console.log(`FAIL ${name} — 期望 ${expected}，实际 ${actual}`);
  }
}

/** 构造一条证据块的文本（与页面 .answer-part 的 innerText 形态一致）。 */
const part = (title, text) => `${title} · 完整小节\n${text}\n点击放大查看完整答案`;
const pane = (...parts) => parts.join('\n');

// ── R：回归用例（旧口径会漏判的场景）─────────────────────────────────────
const spreadParts = [
  part('1.1 工作时间', '公司实行标准工时制，每日工作 8 小时。'),
  part('1.2 加班与调休', '加班后应在 3 个月内安排调休。'),
];
const spread = judge(
  { expectKeywords: ['标准工时制', '3 个月内'] },
  { refused: false, answer: pane(...spreadParts), parts: spreadParts },
);
check('R01 要点分散在不同小节 → 不通过', spread.pass, false);
check('R01 失败原因指出「分散」', spread.reason.includes('分散'), true);
check('R01 失败原因带上各自所在条号', spread.reason.includes('第 1 条') && spread.reason.includes('第 2 条'), true);

const togetherParts = [part('1.1 工作时间', '公司实行标准工时制；加班应在 3 个月内安排调休。')];
const together = judge(
  { expectKeywords: ['标准工时制', '3 个月内'] },
  { refused: false, answer: pane(...togetherParts), parts: togetherParts },
);
check('R02 同样两个要点落在同一条 → 通过', together.pass, true);

// ── A：基本判定 ──────────────────────────────────────────────────────────
check(
  'A01 单要点命中 → 通过',
  judge({ expectKeywords: ['最长 4 小时'] },
    { refused: false, answer: pane(part('1.1 预约方式', '单次预约最长 4 小时。')), parts: [part('1.1 预约方式', '单次预约最长 4 小时。')] }).pass,
  true,
);
check(
  'A02 要点缺失 → 不通过',
  judge({ expectKeywords: ['最长 8 小时'] },
    { refused: false, answer: pane(part('1.1 预约方式', '单次预约最长 4 小时。')), parts: [part('1.1 预约方式', '单次预约最长 4 小时。')] }).pass,
  false,
);
check(
  'A03 要点缺失原因列出缺的词',
  judge({ expectKeywords: ['最长 8 小时'] },
    { refused: false, answer: '', parts: [part('1.1 预约方式', '最长 4 小时。')] }).reason.includes('最长 8 小时'),
  true,
);

// ── B：拒答 ──────────────────────────────────────────────────────────────
check(
  'B01 应拒答且拒答 → 通过',
  judge({ expectRefusal: true }, { refused: true, answer: '暂未找到足够依据', parts: [] }).pass,
  true,
);
check(
  'B02 应拒答但给了答案 → 不通过',
  judge({ expectRefusal: true }, { refused: false, answer: pane(part('1.1', '内容')), parts: [part('1.1', '内容')] }).pass,
  false,
);
check(
  'B03 有预期答案却拒答 → 不通过',
  judge({ expectKeywords: ['X'] }, { refused: true, answer: '', parts: [] }).pass,
  false,
);
check(
  'B04 拒答优先于关键词判定',
  judge({ expectRefusal: true, expectKeywords: ['X'] }, { refused: true, answer: '', parts: [] }).pass,
  true,
);

// ── C：编号小节约束 ──────────────────────────────────────────────────────
const rightUnit = [part('1.2 加班与调休', '加班后应在 3 个月内调休。')];
check(
  'C01 命中预期小节 → 通过',
  judge({ expectKeywords: ['3 个月内'], expectUnitTitle: '1.2 加班与调休' },
    { refused: false, answer: pane(...rightUnit), parts: rightUnit }).pass,
  true,
);
const wrongUnit = [part('1.1 工作时间', '加班应在 3 个月内调休。')];
check(
  'C02 命中证据不是预期小节 → 不通过',
  judge({ expectKeywords: ['3 个月内'], expectUnitTitle: '1.2 加班与调休' },
    { refused: false, answer: pane(...wrongUnit), parts: wrongUnit }).pass,
  false,
);
check(
  'C03 越界到兄弟小节 → 不通过',
  judge({ expectKeywords: ['标准工时制'], rejectUnitTitles: ['1.2 加班与调休'] },
    { refused: false, answer: pane(...spreadParts), parts: spreadParts }).pass,
  false,
);

// ── D：不应出现的内容 ────────────────────────────────────────────────────
check(
  'D01 出现 rejectKeywords → 不通过',
  judge({ expectKeywords: ['禁止使用个人邮箱'], rejectKeywords: ['数据外发审批'] },
    { refused: false, answer: pane(part('3.3 外部传输', '禁止使用个人邮箱；数据外发审批见下。')),
      parts: [part('3.3 外部传输', '禁止使用个人邮箱；数据外发审批见下。')] }).pass,
  false,
);
check(
  'D02 rejectKeywords 在别条出现也算（按整块面板判定）',
  judge({ expectKeywords: ['禁止使用个人邮箱'], rejectKeywords: ['数据外发审批'] },
    { refused: false,
      answer: pane(part('3.3 外部传输', '禁止使用个人邮箱。'), part('3.4', '数据外发审批流程')),
      parts: [part('3.3 外部传输', '禁止使用个人邮箱。'), part('3.4', '数据外发审批流程')] }).pass,
  false,
);

// ── E：边界 ──────────────────────────────────────────────────────────────
check(
  'E01 没有取到证据块 → 不通过',
  judge({ expectKeywords: ['X'] }, { refused: false, answer: '', parts: [] }).pass,
  false,
);
check(
  'E02 无期望关键词但有证据 → 通过（权限组用例形态）',
  judge({}, { refused: false, answer: pane(part('1.1', '内容')), parts: [part('1.1', '内容')] }).pass,
  true,
);
check(
  'E03 parts 非数组时不抛异常',
  judge({ expectKeywords: ['X'] }, { refused: false, answer: 'X', parts: undefined }).pass,
  false,
);

console.log(`\n================ judge 单元测试 ================`);
console.log(`通过 ${passed}/${passed + failures.length}`);
if (failures.length) {
  console.log('失败明细：');
  for (const item of failures) console.log(`  - ${item}`);
  process.exitCode = 1;
}
