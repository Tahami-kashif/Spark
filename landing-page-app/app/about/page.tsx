import Link from 'next/link';

export const metadata = {
  title: 'About Us',
  description: 'Learn more about our premium watch store',
};

export default function AboutPage() {
  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-4xl mx-auto">
        <h1 className="text-4xl font-bold mb-6 text-gray-900">About Us</h1>
        <p className="text-lg text-gray-700 mb-4">
          Premium Watch Store has been delivering timeless elegance since 2020. Our mission is to provide high‑quality watches that combine classic design with modern craftsmanship.
        </p>
        <p className="text-lg text-gray-700 mb-4">
          We source the finest materials and work with skilled artisans to ensure every piece meets our strict standards.
        </p>
        <Link href="/" className="text-indigo-600 hover:underline">
          ← Back to Home
        </Link>
      </div>
    </main>
  );
}
