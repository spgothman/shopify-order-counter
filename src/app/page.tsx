import { OrderCounter } from "@/components/OrderCounter";
import { PasswordGate } from "@/components/PasswordGate";

export default function Home() {
  return (
    <PasswordGate>
      <main className="counter-page">
        <OrderCounter />
      </main>
    </PasswordGate>
  );
}
