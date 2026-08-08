// queue.js — คิวแบบ FIFO รันทีละงาน
//
// ทำไมต้องมี: GPU มีตัวเดียวและ slip-ocr-th serialize อยู่แล้ว (ThreadPoolExecutor max_workers=1)
// การยิงพร้อมกันจึงไม่ได้เร็วขึ้น มีแต่ทำให้ทุกคนรอนานเท่ากันหมด. คุมคิวฝั่งนี้แทน จะได้
// (1) บอกผู้ใช้ได้ว่าอยู่ลำดับที่เท่าไร (2) ปฏิเสธตั้งแต่ต้นถ้าคิวยาวเกิน แทนปล่อยให้ timeout

const q = [];
let running = false;

/** จำนวนงานที่รออยู่ (ไม่นับงานที่กำลังรัน) */
export function depth() {
  return q.length;
}

/** งานที่ต้องรอทั้งหมดก่อนถึงคิวเรา = ที่รออยู่ + ที่กำลังรัน */
export function ahead() {
  return q.length + (running ? 1 : 0);
}

async function drain() {
  if (running) return;
  running = true;
  while (q.length) {
    const { task, resolve, reject } = q.shift();
    try {
      resolve(await task());
    } catch (err) {
      reject(err);
    }
  }
  running = false;
}

/**
 * ต่อคิวงาน → Promise ของผลลัพธ์.
 * `drain()` ไม่ถูก await โดยตั้งใจ — enqueue ต้องคืนทันทีเพื่อให้ผู้เรียกส่งข้อความ
 * "กำลังประมวลผล..." ออกไปก่อนได้ error ของแต่ละงานถูกส่งผ่าน reject ของงานนั้น
 * ไม่รั่วออกมาที่ drain (loop จึงไม่มีทางตายกลางคัน)
 */
export function enqueue(task) {
  return new Promise((resolve, reject) => {
    q.push({ task, resolve, reject });
    drain();
  });
}
