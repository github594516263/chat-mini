import Chat from "@/components/chat";

export default function Page() {
  // 服务端读一次环境变量，只用于在界面上诚实地标注当前是 mock 还是 live
  const live = Boolean(process.env.DEEPSEEK_API_KEY?.trim());
  return <Chat live={live} />;
}
