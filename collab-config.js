// 共同編集（ルーム）用の Firebase 設定。
// Firebase コンソール → プロジェクトの設定 → マイアプリ（ウェブ）に出てくる firebaseConfig をそのまま貼る。
// null のままだと共同編集ボタンは出ず、共有シートはこのブラウザ内だけで動く。
// ここに入る値はブラウザに配る前提の公開用キーで、秘密情報ではない（守りは database.rules.json 側）。
window.GBF_FIREBASE_CONFIG = {
    apiKey: 'AIzaSyCDTtKiZdAoj6EjJWpsVdgyN3srjARI5u8',
    authDomain: 'gbf-tool-3a205.firebaseapp.com',
    databaseURL: 'https://gbf-tool-3a205-default-rtdb.asia-southeast1.firebasedatabase.app',
    projectId: 'gbf-tool-3a205',
    storageBucket: 'gbf-tool-3a205.firebasestorage.app',
    messagingSenderId: '379423081933',
    appId: '1:379423081933:web:74e99262f71f85f58cf084',
};
