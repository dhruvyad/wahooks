export default function AuthLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-bg-primary px-4 py-12">
      {children}
    </div>
  );
}
