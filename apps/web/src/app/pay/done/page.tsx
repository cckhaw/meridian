export const metadata = { title: 'Payment' };

/** Where the provider's payment page sends a customer back to. Public on purpose: the customer is not a user of this portal. Says nothing about the order. */
export default function PayDone() {
  return (
    <main className="mx-auto grid min-h-dvh max-w-md place-items-center px-6 text-center">
      <div>
        <h1 className="text-title1 font-bold">Thank you</h1>
        <p className="mt-2 text-body text-label2">If your payment went through, the store will confirm your order shortly. You can close this page.</p>
      </div>
    </main>
  );
}
