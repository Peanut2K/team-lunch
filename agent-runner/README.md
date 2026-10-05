# agent-runner — ให้ BE Dev / FE Dev / QA เป็น agent จริงใน Linear

```
คุณ delegate issue ให้ agent ใน Linear
        │  webhook (AgentSessionEvent)
        ▼
agent-runner บนเครื่องคุณ ──► ตอบ "thought" ใน Linear ภายใน 10 วิ
        │
        ▼
claude -p --agent <be-dev|fe-dev|qa>   (ใน worktree แยกของ agent นั้น)
   └─ Linear MCP ล็อกอินเป็น "ตัวตนของ agent" (Bearer token ของ app)
        │  ทำงาน → comment → เปลี่ยน status → delegate ให้ node ถัดไป (D13)
        ▼
agent-runner โพสต์ "response" (หรือ "error") กลับเข้า agent session
```

ไม่มี dependency นอกจาก Node 22 · test: `npm test`

---

## ตั้งค่าครั้งแรก (ประมาณ 30 นาที)

### 1. ของที่ต้องมีบน Windows

เปิด PowerShell แล้วเช็ก / ติดตั้ง:

```powershell
node -v            # ต้อง 22 ขึ้นไป
git --version
claude --version   # ถ้าไม่มี: npm install -g @anthropic-ai/claude-code  แล้ว  claude  เพื่อ login ครั้งแรก
gh --version       # ถ้าไม่มี: winget install GitHub.cli  แล้ว  gh auth login
ngrok version      # ถ้าไม่มี: winget install ngrok.ngrok  แล้ว  ngrok config add-authtoken <token จาก ngrok.com>
```

* `gh` ใช้ให้ agent เปิด / merge PR (D7)
* ngrok ใช้เปิด URL สาธารณะให้ Linear ส่ง webhook มาถึงเครื่องคุณ — **ขอ static domain ฟรี 1 ชื่อ** ที่ dashboard.ngrok.com → Domains จะได้ URL เดิมทุกครั้ง ไม่ต้องไปแก้ใน Linear ใหม่

### 2. เปิด tunnel

```powershell
ngrok http --url=<ชื่อ>.ngrok-free.app 8787
```

URL นี้คือ `PUBLIC_URL`

### 3. สร้าง Linear app 3 ตัว

Linear → **Settings → API → OAuth applications → New** ทำซ้ำ 3 รอบ:

| ช่อง | BE Dev | FE Dev | QA |
| -- | -- | -- | -- |
| Name (ต้องตรงตัวนี้ เพราะ agent delegate หากันด้วยชื่อ) | `BE Dev` | `FE Dev` | `QA` |
| Callback URL | `PUBLIC_URL/oauth/be-dev/callback` | `PUBLIC_URL/oauth/fe-dev/callback` | `PUBLIC_URL/oauth/qa/callback` |
| Webhooks: เปิด, URL | `PUBLIC_URL/webhook/be-dev` | `PUBLIC_URL/webhook/fe-dev` | `PUBLIC_URL/webhook/qa` |
| Webhook events | ✔ **Agent session events** | ✔ เหมือนกัน | ✔ เหมือนกัน |

แต่ละตัวจด **Client ID**, **Client secret**, **Webhook signing secret**

### 4. ตั้งค่า .env

```powershell
cd $HOME\Desktop\team-lunch\agent-runner
copy .env.example .env
notepad .env      # ใส่ PUBLIC_URL และ ID / secret ของ 3 app
```

### 5. เช็กเครื่อง แล้วเปิด daemon

```powershell
npm run doctor              # ✔ / ✘ ทีละข้อ พร้อมวิธีแก้
.\daemon\install.ps1        # รัน ngrok + agent-runner เบื้องหลังเดี๋ยวนี้ และทุกครั้งที่ล็อกอิน Windows
```

* Dashboard: http://localhost:8787 — agent ไหนติดตั้งแล้ว / กำลังทำใบไหน / คิว / งานล่าสุด
* Log: `agent-runner\logs\`
* หยุดและเอาออกจาก startup: `.\daemon\uninstall.ps1` · ดูสถานะใน terminal: `.\daemon\status.ps1`
* อยากรันแบบเห็นหน้าจอ (ตอน debug) ใช้ `npm start` แทน
* ถ้า PowerShell ไม่ยอมรันสคริปต์: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`

### 6. ติดตั้ง agent เข้า workspace

เปิด 3 ลิงก์นี้ในเบราว์เซอร์ (ทีละอัน) แล้วกด Authorize — เลือกให้เข้าถึงทีม **Backend** และ **Frontend**:

* `PUBLIC_URL/oauth/be-dev/install`
* `PUBLIC_URL/oauth/fe-dev/install`
* `PUBLIC_URL/oauth/qa/install`

(หรือกดลิงก์ "ติดตั้ง" ใน dashboard) — เสร็จแล้ว dashboard ต้องขึ้น "ว่าง" ทั้ง 3 ตัว

### 7. ลองใช้

ใน Linear เปิด issue แล้ว **assign ให้ agent** (ช่อง assignee จะมี BE Dev / FE Dev / QA) — Linear จะตั้งเป็น delegate โดยคุณยังเป็นเจ้าของ

* ภายในไม่กี่วินาทีจะเห็น "QA รับงาน … แล้ว" ใน issue
* agent ทำงานแล้วส่งต่อให้ node ถัดไปเอง (ดู Graph spec / Decision log D13)

---

## ข้อควรรู้

* **ต้องเปิดคอมไว้** agent ถึงจะทำงาน (daemon เปิดให้เองตอนล็อกอิน) — นี่คือแบบ A · แบบ B คือย้ายไป serverless
* ถ้า agent-runner ล่ม daemon จะเปิดใหม่ให้เองใน 5 วินาที · ถ้าคอมดับระหว่างทำงาน issue จะค้างที่ `In Progress` แล้ว agent จะรับงานต่อจาก checklist + git log ตอน delegate ใหม่
* แต่ละ agent มี worktree ของตัวเองที่ `WORK_DIR\<agent>` ทำทีละ 1 งาน งานที่มาซ้อนจะเข้าคิว
* `CLAUDE_PERMISSION_MODE=bypassPermissions` ให้ agent รันคำสั่งได้โดยไม่ต้องมีคนกดอนุญาต — ใช้กับ worktree ของ repo นี้เท่านั้น ถ้าอยากเข้มกว่านี้ใช้ `auto`
* token ของ app เก็บใน `.tokens.json` (อยู่ใน .gitignore) และ refresh เองทุก 24 ชม.
* Agent API ของ Linear ยังเป็น **Developer Preview**
