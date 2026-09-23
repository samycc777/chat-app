# Classroom web app

The browser app is built with Vue 3, TypeScript, and Vite. The root package scripts run it together with the Express and Socket.IO server, build both, and run the server tests.

It provides the join screen, the class chat (messages, replies, links, images, and PDFs), the People and Display menus, the on-screen Arabic keyboard, and the live lesson screen, in Arabic and English. The lesson screen uses `livekit-client` and is loaded only when a lesson starts, which keeps the first download small for students on mobile data. Arabic text is set in the bundled Noto Naskh Arabic font (`@fontsource/noto-naskh-arabic`, SIL Open Font License), limited to Arabic script so Latin text keeps the system font.
