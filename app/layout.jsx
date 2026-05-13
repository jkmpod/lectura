export const metadata = {
  title: "Lectura — A study companion",
  description: "Explore lessons with synced transcripts, practice questions, and further reading.",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body style={{ margin: 0 }}>{children}</body>
    </html>
  );
}
