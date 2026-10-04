# ข้าวเที่ยงทีม (Team Lunch)

เว็บสั่งข้าวกลางวันรวมของทีม — และเป็น project ทดลอง **graph engineering บน Linear** (agent หลายตัวทำงานเป็นทีมผ่าน Linear)

## ทางเข้า graph

* Linear project: https://linear.app/oatsapon/project/team-lunch-6f697a00346f (ทีม Backend `BE`, Frontend `FE`)
* Parent issue: **BE-20 Team Lunch MVP**
* กติกาของ graph: [Graph spec](https://linear.app/oatsapon/document/graph-spec-3cb0f96b974b)
* ความรู้: [PRD](https://linear.app/oatsapon/document/prd-46157ec6fb61) · [API contract](https://linear.app/oatsapon/document/api-contract-ad39c95bdc89) · [Design brief](https://linear.app/oatsapon/document/design-brief-0237145dc19d) · [Decision log](https://linear.app/oatsapon/document/decision-log-01b85fe1d990)

**State และความรู้อยู่ใน Linear เท่านั้น** — อย่า copy PRD / API contract มาเก็บใน repo และอย่าเก็บ state เป็นไฟล์

## ใครแก้โฟลเดอร์ไหน

| โฟลเดอร์ | เจ้าของ | Agent |
| -- | -- | -- |
| `server/` | Backend | `.claude/agents/be-dev.md` |
| `web/` | Frontend | `.claude/agents/fe-dev.md` |
| `qa/` | QA | `.claude/agents/qa.md` |

## Git

* 1 issue = 1 branch ตามชื่อที่ Linear ตั้งให้ (`gitBranchName` ของ issue)
* commit ทุกครั้งที่ติ๊ก checklist 1 ข้อ · ข้อความ commit ขึ้นต้นด้วย issue ID เช่น `BE-21: POST /api/rounds validation`
* QA ผ่านแล้ว merge เข้า `main`

## รัน

* Backend: `cd server && npm install && npm test` · start: `npm start` (port 3000)
* Frontend: เปิด `web/index.html` (server จำลอง) หรือเสิร์ฟผ่าน backend ที่ `/`
