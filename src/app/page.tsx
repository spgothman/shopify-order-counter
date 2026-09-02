import { AppShell } from "@/components/AppShell";
import { PasswordGate } from "@/components/PasswordGate";

export default function Home() {
  return (
    <PasswordGate>
      <AppShell />
    </PasswordGate>
  );
}
