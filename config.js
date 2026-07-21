/**
 * RASA CONNECT 設定檔
 *
 * 1. 在 Supabase 建立專案並執行 supabase/schema.sql
 * 2. 將 Project URL 與 Publishable Key 貼到下方
 * 3. GitHub Pages 網址不必手動填寫，系統會自動依目前網址生成個人 QR
 */
window.RASA_CONFIG = {
  SUPABASE_URL: "https://lqcpschmwvcjzkugdzed.supabase.co",
  SUPABASE_KEY: "sb_publishable_pkU2JMAAc3ZABptCI2RqQw_2v_5FFQ_",

  // 前端顯示設定
  FRIEND_GOAL: 10,
  MILESTONES: [
    {
      count: 1,
      title: "初次連線",
      message: "恭喜你成功跨越舒適圈！認識新朋友的感覺不錯吧？"
    },
    {
      count: 3,
      title: "社交暖機",
      message: "你已經在人群裡建立第一段連線，今晚才正要開始。"
    },
    {
      count: 6,
      title: "漸入佳境",
      message: "六次相遇已經發生。再向前一步，也許下一位就是意想不到的同路人。"
    },
    {
      count: 10,
      title: "E 級社交王",
      message: "恭喜你成為 E 級社交王！你將有權競爭本場活動的認識王寶座。"
    }
  ]
};
