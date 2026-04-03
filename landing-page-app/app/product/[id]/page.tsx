import Image from 'next/image';
import Link from 'next/link';

export async function generateStaticParams() {
  return [{ id: "1" }, { id: "2" }, { id: "3" }];
}

const PRODUCT_DATA: Record<string, { title: string; image: string; description: string; price: string }> = {
  "1": {
    title: "Elegant Watch 1",
    image: "https://picsum.photos/seed/artistic-3/800/600",
    description: "Detailed description for product 1. Premium watch with timeless design.",
    price: "$199.99",
  },
  "2": {
    title: "Elegant Watch 2",
    image: "https://picsum.photos/seed/canvas-4/800/600",
    description: "Detailed description for product 2. Premium watch with timeless design.",
    price: "$199.99",
  },
  "3": {
    title: "Elegant Watch 3",
    image: "https://picsum.photos/seed/art-0/800/600",
    description: "Detailed description for product 3. Premium watch with timeless design.",
    price: "$199.99",
  },
};

export default async function ProductPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const product = PRODUCT_DATA[id] ?? PRODUCT_DATA["1"];
  return (
    <main className="min-h-screen bg-white p-4 flex flex-col items-center">
      <h1 className="text-3xl font-bold mb-6">{product.title}</h1>
      <div className="max-w-2xl w-full bg-gray-50 rounded-lg shadow-md overflow-hidden">
        <Image
          src={product.image}
          alt={product.title}
          width={800}
          height={600}
          className="object-cover w-full"
        />
        <div className="p-6">
          <p className="text-gray-700 mb-4">{product.description}</p>
          <p className="text-xl font-bold mb-4">{product.price}</p>
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
