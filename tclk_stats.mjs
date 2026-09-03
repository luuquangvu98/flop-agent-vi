// tclk_stats.mjs — do phong tclk-offers. CHI DOC, khong ghi gi, khong can key.
//
//   node tclk_stats.mjs           <- do 15 phut (mac dinh)
//   node tclk_stats.mjs 30        <- do 30 phut
//   node tclk_stats.mjs 5 10      <- do 5 phut, doc moi 10 giay
//
// Ket qua:
//   tclk_sample.txt   — du lieu tho, mot dong mot tin (de nguoi khac chay lai)
//   tclk_stats.json   — bang so lieu
//
// Phuong phap: doc /r/tclk-offers?format=json moi N giay, gop theo seq (bo trung).
// API chi tra 50 tin gan nhat, nen neu phong chay nhanh hon 50 tin / N giay thi
// se BO LO tin. Script tu phat hien va bao ro do phu — khong giau con so do.

import { writeFileSync, appendFileSync } from "node:fs";
import { tryDecodeFrame, OFFER_ROOM } from "@flop-labs/tclk";

const BASE = "https://technocore.chat";
const UA = { "User-Agent": "flop-agent-vi/1.0" };
const PHUT = Number(process.argv[2] ?? 15);
const GIAY_MOI_LAN = Number(process.argv[3] ?? 20);
const RAW = "tclk_sample.txt";
const OUT = "tclk_stats.json";

if (!(PHUT > 0) || !(GIAY_MOI_LAN >= 5)) {
  console.log("Dung: node tclk_stats.mjs [so phut] [so giay moi lan doc >=5]");
  process.exit(1);
}

// ------------------------------------------------------------------ thu thap
const seen = new Map();          // seq -> {ts, from, text, sig}
let lanDoc = 0, loi = 0, boLo = 0, seqCaoNhat = 0, seqDauTien = null;

async function docMotLan() {
  try {
    const r = await fetch(`${BASE}/r/${OFFER_ROOM}?format=json`, { headers: UA });
    if (!r.ok) { loi++; return; }
    const d = await r.json();
    lanDoc++;
    if (seqDauTien === null) seqDauTien = d.first_seq;
    // Neu first_seq cua lan doc nay > seq cao nhat da thay + 1 => co tin bi bo lo
    if (seqCaoNhat > 0 && d.first_seq > seqCaoNhat + 1) boLo += d.first_seq - seqCaoNhat - 1;
    for (const m of d.messages ?? []) {
      if (!seen.has(m.seq)) seen.set(m.seq, { ts: m.ts, from: m.from, text: m.text ?? "", sig: m.sig });
      seqCaoNhat = Math.max(seqCaoNhat, m.seq);
    }
  } catch { loi++; }
}

const soLan = Math.ceil((PHUT * 60) / GIAY_MOI_LAN);
console.log("=".repeat(70));
console.log(` DO PHONG ${OFFER_ROOM} — ${PHUT} phut, doc moi ${GIAY_MOI_LAN} giay (${soLan} lan)`);
console.log("=".repeat(70));
console.log(" Cu de day, khong can lam gi. Ctrl+C de dung som (van ghi ket qua).\n");

const batDau = Date.now();
let dungSom = false;
process.on("SIGINT", () => { dungSom = true; });

for (let i = 0; i < soLan && !dungSom; i++) {
  await docMotLan();
  const conLai = ((soLan - i - 1) * GIAY_MOI_LAN / 60).toFixed(1);
  process.stdout.write(`\r  lan ${i + 1}/${soLan}  da gom ${seen.size} tin  con ${conLai} phut   `);
  if (i < soLan - 1 && !dungSom) await new Promise((s) => setTimeout(s, GIAY_MOI_LAN * 1000));
}
const ketThuc = Date.now();
console.log("\n");

// ------------------------------------------------------------------ ghi tho
const rows = [...seen.entries()].sort((a, b) => a[0] - b[0]);
const header = [
  `# Du lieu tho tu ${BASE}/r/${OFFER_ROOM}`,
  `# Bat dau: ${new Date(batDau).toISOString()}`,
  `# Ket thuc: ${new Date(ketThuc).toISOString()}`,
  `# ${rows.length} tin gom duoc, ${lanDoc} lan doc, ${loi} lan loi`,
  "",
].join("\n");
writeFileSync(RAW, header);
for (const [seq, m] of rows) {
  appendFileSync(RAW, `[${seq}] ${m.ts} <${(m.from ?? "?").slice(0, 12)}…> ${m.sig ? "S" : "-"} ${m.text}\n`);
}

// ------------------------------------------------------------------ phan tich
const frames = [];
let khongPhaiFrame = 0;
for (const [seq, m] of rows) {
  const f = tryDecodeFrame(m.text);
  if (f) frames.push({ seq, ts: Date.parse(m.ts), from: m.from, sig: !!m.sig, f });
  else khongPhaiFrame++;
}

const dem = {};
for (const x of frames) dem[x.f.type] = (dem[x.f.type] ?? 0) + 1;

// --- lan theo tung hop dong ---
const offers = new Map();     // offer id -> {x}
const keo = new Map();        // contract id -> {offer, accept, lock, reveal, receipt, refund}
for (const x of frames) {
  if (x.f.type === "offer") offers.set(x.f.id, x);
}
for (const x of frames) {
  const c = x.f.contract;
  if (!c) continue;
  if (!keo.has(c)) keo.set(c, {});
  const k = keo.get(c);
  if (x.f.type === "accept") { k.accept = x; k.offer = offers.get(x.f.ref); }
  else k[x.f.type] = x;
}

const coAccept = [...keo.values()].filter((k) => k.accept);
const coLock = coAccept.filter((k) => k.lock);
const coReveal = coLock.filter((k) => k.reveal);
const coReceipt = coReveal.filter((k) => k.receipt);
const coRefund = coAccept.filter((k) => k.refund);

// --- toc do hoan tat ---
const trongVong = (k, giay) => k.offer && k.receipt && (k.receipt.ts - k.offer.ts) <= giay * 1000;
const duoi1Giay = coReceipt.filter((k) => trongVong(k, 1)).length;
const duoi5Giay = coReceipt.filter((k) => trongVong(k, 5)).length;

const doTre = (a, b) => (a && b ? (b.ts - a.ts) / 1000 : null);
const trungVi = (arr) => {
  const v = arr.filter((x) => x !== null).sort((a, b) => a - b);
  return v.length ? v[Math.floor(v.length / 2)] : null;
};
const offerToiAccept = trungVi(coAccept.map((k) => doTre(k.offer, k.accept)));
const acceptToiLock  = trungVi(coLock.map((k) => doTre(k.accept, k.lock)));
const lockToiReveal  = trungVi(coReveal.map((k) => doTre(k.lock, k.reveal)));

// --- danh tinh ---
const demDid = new Map();
for (const x of frames) demDid.set(x.from, (demDid.get(x.from) ?? 0) + 1);
const didMotLan = [...demDid.values()].filter((v) => v === 1).length;

// cap tu giao dich: 2 DID chi tung xuat hien cung nhau trong dung 1 hop dong
let capTuGiao = 0;
for (const k of coReceipt) {
  const bên = new Set([k.offer?.from, k.accept?.from].filter(Boolean));
  if (bên.size !== 2) continue;
  const chiTrongKeoNay = [...bên].every((d) => {
    const cacKeo = new Set(frames.filter((x) => x.from === d && x.f.contract).map((x) => x.f.contract));
    return cacKeo.size === 1;
  });
  if (chiTrongKeoNay) capTuGiao++;
}

// --- cong viec ---
const dsOffer = frames.filter((x) => x.f.type === "offer");
const coJob = dsOffer.filter((x) => x.f.job);
const coTaiLieu = dsOffer.filter((x) => x.f.job?.context);
const theoTenViec = {};
for (const x of coJob) {
  const g = x.f.job.id.replace(/[-_][0-9a-f]{4,}$/i, "");   // bo duoi hex ngau nhien
  theoTenViec[g] = (theoTenViec[g] ?? 0) + 1;
}
const railDem = {};
for (const x of dsOffer) for (const r of x.f.rails) railDem[r] = (railDem[r] ?? 0) + 1;
const assetDem = {};
for (const x of dsOffer) assetDem[x.f.asset] = (assetDem[x.f.asset] ?? 0) + 1;

// --- luu luong va do phu ---
const giay = (ketThuc - batDau) / 1000;
const khoangSeq = seqCaoNhat - (seqDauTien ?? seqCaoNhat) + 1;   // ca hai dau deu tinh
const tocDo = khoangSeq / giay;
const doPhu = khoangSeq > 0 ? rows.length / khoangSeq : 1;

// ------------------------------------------------------------------ in ra
const pct = (a, b) => (b ? (100 * a / b).toFixed(1) + "%" : "-");
const L = (n, v) => console.log(`  ${String(n).padEnd(42)} ${v}`);

console.log("=".repeat(70));
console.log(" KET QUA");
console.log("=".repeat(70));
console.log("\n[1] QUY MO");
L("Cua so do", `${(giay / 60).toFixed(1)} phut`);
L("Seq tu -> den", `${seqDauTien} -> ${seqCaoNhat}`);
L("Tin sinh ra trong cua so (hieu so seq)", khoangSeq);
L("Tin gom duoc", rows.length);
L(">> DO PHU", pct(rows.length, khoangSeq));
L("Uoc luong bi bo lo", boLo);
L(">> TOC DO", `${tocDo.toFixed(2)} tin/giay = ${(tocDo * 60).toFixed(1)} tin/phut`);
L("Mot offer nhin thay duoc khoang", `${(50 / tocDo / 60).toFixed(1)} phut`);

console.log("\n[2] LOAI FRAME");
for (const t of ["offer", "accept", "lock", "reveal", "receipt", "refund", "cancel"]) {
  if (dem[t]) L(t, dem[t]);
}
L("Dong khong phai frame tclk", khongPhaiFrame);

console.log("\n[3] PHEU — bao nhieu keo di duoc toi cuoi");
L("Offer", dsOffer.length);
L("-> co accept", `${coAccept.length}  (${pct(coAccept.length, dsOffer.length)} so offer)`);
L("-> co lock", `${coLock.length}  (${pct(coLock.length, coAccept.length)} so accept)`);
L("-> co reveal", `${coReveal.length}  (${pct(coReveal.length, coLock.length)} so lock)`);
L("-> co receipt", `${coReceipt.length}`);
L("-> refund (khong ai lam)", coRefund.length);

console.log("\n[4] DAU HIEU TU GIAO DICH");
L("Keo hoan tat trong DUOI 1 GIAY", `${duoiGiayStr(duoi1Giay, coReceipt.length)}`);
L("Keo hoan tat trong duoi 5 giay", `${duoiGiayStr(duoi5Giay, coReceipt.length)}`);
L("Cap DID chi ton tai trong 1 keo duy nhat", capTuGiao);
L("Trung vi: offer -> accept", offerToiAccept === null ? "-" : `${offerToiAccept.toFixed(2)} giay`);
L("Trung vi: accept -> lock", acceptToiLock === null ? "-" : `${acceptToiLock.toFixed(2)} giay`);
L("Trung vi: lock -> reveal", lockToiReveal === null ? "-" : `${lockToiReveal.toFixed(2)} giay`);

console.log("\n[5] DANH TINH");
L("So DID khac nhau", demDid.size);
L("DID chi xuat hien dung 1 lan", `${didMotLan}  (${pct(didMotLan, demDid.size)})`);

console.log("\n[6] CONG VIEC");
L("Offer co truong job", `${coJob.length}  (${pct(coJob.length, dsOffer.length)})`);
L("Offer co tai lieu cong viec (job.context)", `${coTaiLieu.length}  (${pct(coTaiLieu.length, dsOffer.length)})`);
const topViec = Object.entries(theoTenViec).sort((a, b) => b[1] - a[1]).slice(0, 8);
for (const [ten, n] of topViec) L(`   ${ten}`, n);

console.log("\n[7] RAIL VA ASSET");
for (const [k, v] of Object.entries(railDem).sort((a, b) => b[1] - a[1])) L(`rail ${k}`, v);
for (const [k, v] of Object.entries(assetDem).sort((a, b) => b[1] - a[1])) L(`asset ${k}`, v);

function duoiGiayStr(n, tong) { return `${n}  (${pct(n, tong)} so keo hoan tat)`; }

// ------------------------------------------------------------------ luu json
const ket = {
  do_luc: { bat_dau: new Date(batDau).toISOString(), ket_thuc: new Date(ketThuc).toISOString(), giay },
  quy_mo: { seq_tu: seqDauTien, seq_den: seqCaoNhat, tin_sinh_ra: khoangSeq, tin_gom_duoc: rows.length,
            do_phu: doPhu, toc_do_tin_moi_giay: tocDo, uoc_bo_lo: boLo, lan_doc: lanDoc, lan_loi: loi },
  frame: dem, khong_phai_frame: khongPhaiFrame,
  pheu: { offer: dsOffer.length, accept: coAccept.length, lock: coLock.length,
          reveal: coReveal.length, receipt: coReceipt.length, refund: coRefund.length },
  tu_giao_dich: { duoi_1_giay: duoi1Giay, duoi_5_giay: duoi5Giay, cap_chi_1_keo: capTuGiao,
                  trung_vi_offer_accept_giay: offerToiAccept,
                  trung_vi_accept_lock_giay: acceptToiLock,
                  trung_vi_lock_reveal_giay: lockToiReveal },
  danh_tinh: { did_khac_nhau: demDid.size, did_1_lan: didMotLan },
  cong_viec: { co_job: coJob.length, co_tai_lieu: coTaiLieu.length, theo_ten: theoTenViec },
  rail: railDem, asset: assetDem,
};
writeFileSync(OUT, JSON.stringify(ket, null, 2));

console.log("\n" + "=".repeat(70));
console.log(` Du lieu tho : ${RAW}   (${rows.length} dong)`);
console.log(` Bang so lieu: ${OUT}`);
console.log(" Gui 2 file nay cho Claude.");
console.log("=".repeat(70));
