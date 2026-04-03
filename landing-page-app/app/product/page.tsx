import Image from 'next/image';
import Link from 'next/link';

export default function ProductPage() {
  return (
    <main className="min-h-screen bg-white p-4 flex flex-col items-center">
      <h1 className="text-3xl font-bold mb-6">Product Details</h1>
      <div className="max-w-2xl w-full bg-gray-50 rounded-lg shadow-md overflow-hidden">
        <Image
          src="https://picsum.photos/seed/beautiful-2/800/600"
          alt="Product Image"
          width={800}
          height={600}
          className="object-cover w-full"
        />
        <div className="p-6">
          <h2 className="text-2xl font-semibold mb-2">Elegant Watch</h2>
          <p className="text-gray-700 mb-4">
            Experience timeless elegance with our premium watch, crafted with precision
            and style. Perfect for any occasion.
          </p>
          <p className="text-xl font-bold mb-4">$199.99</p>
          <button className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition">
            Add to Cart
          </button>
        </div>
      </div>
      <Link href="/" className="mt-6 text-blue-600 hover:underline">
        ← Back to Home
      </Link>
    </main>
  );
}
