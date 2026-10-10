# 离线评测报告

- 生成时间：2026-10-10T07:34:27.082Z
- 被测对象：`index.html`（本地浏览器原型）
- 语料：corpus/员工手册（演示）.md、corpus/财务报销制度（演示）.md、corpus/培训与职业发展管理办法（演示）.md、corpus/会议室与办公环境管理办法（演示）.md + 内置 5 份演示制度
- 用例总数：**118**，通过 **118**，综合通过率 **100%**
- 判定口径：期望要点必须落在**同一条证据**内（页面上每个 `.answer-part` 为一条），且命中的那条须为预期编号小节；要点分散在不同小节、或越界到兄弟小节，均判为不通过

## 分组指标

| 分组 | 用例数 | 通过 | 通过率 |
| --- | ---: | ---: | ---: |
| 自然语言检索：应返回包含预期要点的答案 | 52 | 52 | 100% |
| 同义改写：用词与原文不同，仍应召回同一小节 | 20 | 20 | 100% |
| 编号定位：按序号只返回该编号对应的答案 | 10 | 10 | 100% |
| 无依据拒答：语料中不存在该主题，必须明确拒答 | 26 | 26 | 100% |
| 权限隔离：不同演示身份可见范围不同 | 10 | 10 | 100% |

## 逐条结果

| 用例 | 分组 | 身份 | 问题 | 结果 | 说明 |
| --- | --- | --- | --- | --- | --- |
| E01 | retrieval | employee | 年假要提前几天申请 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E02 | retrieval | employee | 连续病假超过几天需要交证明材料 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E03 | retrieval | employee | 年假额度怎么确定 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E04 | retrieval | employee | 差旅报销需要提交哪些材料 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E05 | retrieval | employee | 住宿费报销需要什么凭证 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E06 | retrieval | employee | 差旅报销的流程是什么 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E07 | retrieval | employee | 超出差旅标准的费用怎么处理 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E08 | retrieval | employee | 交通费报销需要哪些凭证 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E09 | retrieval | employee | 怎么申请电脑设备 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E10 | retrieval | employee | 设备故障怎么办 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E11 | retrieval | employee | 离职的时候设备要归还吗 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E12 | retrieval | employee | 设备申请由谁确认业务需要 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E13 | retrieval | employee | 工作时间是怎么规定的 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E14 | retrieval | employee | 加班怎么调休 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E15 | retrieval | employee | 有哪些请假类型 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E16 | retrieval | employee | 加班需要提前审批吗 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E17 | retrieval | employee | 弹性上下班时间怎么安排 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E18 | retrieval | employee | 发薪日是什么时候 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E19 | retrieval | employee | 公司给员工缴纳哪些保险 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E20 | retrieval | employee | 补充医疗保险什么时候生效 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E21 | retrieval | employee | 发薪日遇到节假日会提前发吗 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E22 | retrieval | employee | 密码长度是多少 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E23 | retrieval | employee | 数据分几级 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E24 | retrieval | employee | 工作文件可以发到个人邮箱吗 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E25 | retrieval | employee | 数据分级是怎么规定的 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E26 | retrieval | employee | 向外部合作方传输数据需要审批吗 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E27 | retrieval | employee | 账号密码可以和其他网站共用吗 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E28 | retrieval | employee | 报销要在多久内提交 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E29 | retrieval | employee | 跨年度费用什么时候报销完 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E30 | retrieval | employee | 报销发票抬头有什么要求 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E31 | retrieval | employee | 发票可以拆分开吗 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E32 | retrieval | employee | 业务招待费怎么申请 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E33 | retrieval | employee | 办公用品由谁统一采购 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E34 | retrieval | employee | 报销单由谁审核 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E35 | retrieval | employee | 报销款什么时候到账 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E36 | retrieval | employee | 差旅费用包含哪些项目 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E37 | retrieval | employee | 入职培训要在几天内完成 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E38 | retrieval | employee | 带教期是多长时间 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E39 | retrieval | employee | 试用期一般是多久 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E40 | retrieval | employee | 内部课程多久组织一次 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E41 | retrieval | employee | 参加外部培训要谁审批 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E42 | retrieval | employee | 培训费用由谁承担 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E43 | retrieval | employee | 公司有几种晋升通道 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E44 | retrieval | employee | 学习资源补贴有多少 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E45 | retrieval | employee | 申请内部轮岗需要什么条件 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E46 | retrieval | employee | 会议室一次可以预约多久 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E47 | retrieval | employee | 预约了会议室未到场会怎样 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E48 | retrieval | employee | 访客可以直接进入办公区域吗 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E49 | retrieval | employee | 个人打印量有什么限制 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E50 | retrieval | employee | 可以私自调换工位吗 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E51 | retrieval | employee | 公司代收私人快递吗 | ✅ 通过 | 命中预期要点（同一条证据内） |
| E52 | retrieval | employee | 会议室设备坏了怎么办 | ✅ 通过 | 命中预期要点（同一条证据内） |
| S01 | synonym | employee | 口令多久需要更换一次 | ✅ 通过 | 命中预期要点（同一条证据内） |
| S02 | synonym | employee | 薪水什么时候发 | ✅ 通过 | 命中预期要点（同一条证据内） |
| S03 | synonym | employee | 报账需要提供什么凭证 | ✅ 通过 | 命中预期要点（同一条证据内） |
| S04 | synonym | employee | 加班之后可以补休吗 | ✅ 通过 | 命中预期要点（同一条证据内） |
| S05 | synonym | employee | 出差回来怎么报账 | ✅ 通过 | 命中预期要点（同一条证据内） |
| S06 | synonym | hr | 新人报到当天要办什么 | ✅ 通过 | 命中预期要点（同一条证据内） |
| S07 | synonym | employee | 会议室能预订多长时间 | ✅ 通过 | 命中预期要点（同一条证据内） |
| S08 | synonym | employee | 辞职后设备要归还吗 | ✅ 通过 | 命中预期要点（同一条证据内） |
| S09 | synonym | employee | 病休需要开证明吗 | ✅ 通过 | 命中预期要点（同一条证据内） |
| S10 | synonym | employee | 公积金按什么基数缴 | ✅ 通过 | 命中预期要点（同一条证据内） |
| S11 | synonym | manager | 采购申请走什么审批 | ✅ 通过 | 命中预期要点（同一条证据内） |
| S12 | synonym | employee | 报销单谁来签批 | ✅ 通过 | 命中预期要点（同一条证据内） |
| S13 | synonym | employee | 年休假怎么申请 | ✅ 通过 | 命中预期要点（同一条证据内） |
| S14 | synonym | employee | 培训报名后缺席会怎样 | ✅ 通过 | 命中预期要点（同一条证据内） |
| S15 | synonym | employee | 设备故障找谁报修 | ✅ 通过 | 命中预期要点（同一条证据内） |
| S16 | synonym | employee | 试用期多长时间 | ✅ 通过 | 命中预期要点（同一条证据内） |
| S17 | synonym | employee | 报销发票抬头怎么写 | ✅ 通过 | 命中预期要点（同一条证据内） |
| S18 | synonym | employee | 出差住宿要什么凭证 | ✅ 通过 | 命中预期要点（同一条证据内） |
| S19 | synonym | employee | 每月几号发薪水 | ✅ 通过 | 命中预期要点（同一条证据内） |
| S20 | synonym | employee | 内部课程多久上一次 | ✅ 通过 | 命中预期要点（同一条证据内） |
| O01 | ordinal | employee | 追问1 | ✅ 通过 | 命中预期要点（同一条证据内） |
| O02 | ordinal | employee | 追问2 | ✅ 通过 | 命中预期要点（同一条证据内） |
| O03 | ordinal | employee | 追问3 | ✅ 通过 | 命中预期要点（同一条证据内） |
| O04 | ordinal | employee | 追问1 | ✅ 通过 | 命中预期要点（同一条证据内） |
| O05 | ordinal | employee | 追问2 | ✅ 通过 | 命中预期要点（同一条证据内） |
| O06 | ordinal | employee | 追问3 | ✅ 通过 | 命中预期要点（同一条证据内） |
| O07 | ordinal | employee | 追问1 | ✅ 通过 | 命中预期要点（同一条证据内） |
| O08 | ordinal | employee | 追问3 | ✅ 通过 | 命中预期要点（同一条证据内） |
| O09 | ordinal | employee | 追问2 | ✅ 通过 | 命中预期要点（同一条证据内） |
| O10 | ordinal | employee | 第 3 题 | ✅ 通过 | 命中预期要点（同一条证据内） |
| O11 | refusal | employee | 追问9 | ✅ 通过 | 正确拒答 |
| R01 | refusal | employee | 公司食堂的营业时间是几点 | ✅ 通过 | 正确拒答 |
| R02 | refusal | employee | 公司年会在哪里举办 | ✅ 通过 | 正确拒答 |
| R03 | refusal | employee | 竞争对手的产品报价是多少 | ✅ 通过 | 正确拒答 |
| R04 | refusal | employee | 公司股票代码是什么 | ✅ 通过 | 正确拒答 |
| R05 | refusal | employee | CEO 的私人手机号是多少 | ✅ 通过 | 正确拒答 |
| R06 | refusal | employee | 办公室停车位怎么申请 | ✅ 通过 | 正确拒答 |
| R07 | refusal | employee | 团建经费的标准是多少 | ✅ 通过 | 正确拒答 |
| R08 | refusal | employee | 公司用的是哪家 ERP 系统 | ✅ 通过 | 正确拒答 |
| R09 | refusal | employee | 打印机怎么连无线网 | ✅ 通过 | 正确拒答 |
| R10 | refusal | employee | 年终奖什么时候发 | ✅ 通过 | 正确拒答 |
| R11 | refusal | employee | 公司班车路线是怎么安排的 | ✅ 通过 | 正确拒答 |
| R12 | refusal | employee | 员工持股计划怎么参加 | ✅ 通过 | 正确拒答 |
| R13 | refusal | employee | 工牌丢了怎么补办 | ✅ 通过 | 正确拒答 |
| R14 | refusal | employee | 公司有没有健身房 | ✅ 通过 | 正确拒答 |
| R15 | refusal | employee | 加班有餐补吗 | ✅ 通过 | 正确拒答 |
| R16 | refusal | employee | 公司有没有员工宿舍 | ✅ 通过 | 正确拒答 |
| R17 | refusal | employee | 报销可以预支现金吗 | ✅ 通过 | 正确拒答 |
| R18 | refusal | employee | 年假可以折现吗 | ✅ 通过 | 正确拒答 |
| R19 | refusal | employee | 公司有没有托儿所 | ✅ 通过 | 正确拒答 |
| R20 | refusal | employee | 端午节放假几天 | ✅ 通过 | 正确拒答 |
| R21 | refusal | employee | 公司发的电脑是什么品牌 | ✅ 通过 | 正确拒答 |
| R22 | refusal | employee | 入职体检在哪个医院 | ✅ 通过 | 正确拒答 |
| R23 | refusal | employee | 部门团建的预算是多少 | ✅ 通过 | 正确拒答 |
| R24 | refusal | employee | 员工推荐奖金是多少 | ✅ 通过 | 正确拒答 |
| R25 | refusal | employee | 公司可以远程办公吗 | ✅ 通过 | 正确拒答 |
| P01 | permission | employee | 入职当天要办理什么手续 | ✅ 通过 | 正确拒答 |
| P02 | permission | hr | 入职当天要办理什么手续 | ✅ 通过 | 命中预期要点（同一条证据内） |
| P03 | permission | employee | 部门采购的审批流程 | ✅ 通过 | 正确拒答 |
| P04 | permission | manager | 部门采购的审批流程 | ✅ 通过 | 命中预期要点（同一条证据内） |
| P05 | permission | employee | 新人入职要交什么材料 | ✅ 通过 | 正确拒答 |
| P06 | permission | hr | 员工个人材料谁能查阅 | ✅ 通过 | 命中预期要点（同一条证据内） |
| P07 | permission | admin | 新人入职要办什么手续 | ✅ 通过 | 命中预期要点（同一条证据内） |
| P08 | permission | employee | 采购申请需要谁审批 | ✅ 通过 | 正确拒答 |
| P09 | permission | hr | 部门采购的审批流程 | ✅ 通过 | 正确拒答 |
| P10 | permission | manager | 入职当天要办理什么手续 | ✅ 通过 | 正确拒答 |