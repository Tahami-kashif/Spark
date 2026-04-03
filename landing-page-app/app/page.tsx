import Header from '../components/Header';
import Testimonial from '../components/Testimonial';
import Link from 'next/link';

export default function Home() {
  const heroBg = 'https://picsum.photos/seed/lifestyle-0/800/600';
  const categories = [
    { name: 'Watches', img: 'https://picsum.photos/seed/modern-1/800/600' },
    { name: 'Accessories', img: 'https://picsum.photos/seed/beautiful-2/800/600' },
    { name: 'Gift Sets', img: 'https://picsum.photos/seed/professional-3/800/600' },
  ];
  const featured = [
    'https://picsum.photos/seed/quality-4/800/600',
    'https://picsum.photos/seed/lifestyle-0/800/600',
    'https://picsum.photos/seed/modern-1/800/600',
  ];

  return (
    <main className="min-h-screen bg-gray-50 flex flex-col">
      <Header />

      {/* Hero */}
      <section
        className="h-[70vh] bg-cover bg-center flex items-center justify-center"
        style={{ backgroundImage: `url(${heroBg})` }}
      >
        <div className="bg-black bg-opacity-60 p-8 rounded">
          <h1 className="text-5xl font-bold text-white mb-4 text-center">
            Premium Watches for Every Occasion
          </h1>
          <p className="text-lg text-white text-center mb-6">
            Shop our exclusive collection and enjoy free worldwide shipping.
          </p>
          <div className="flex justify-center">
            <a
              href="#products"
              className="bg-indigo-600 hover:bg-indigo-700 text-white font-medium py-3 px-6 rounded transition"
            >
              Explore Store
            </a>
          </div>
        </div>
      </section>

      {/* Categories */}
      <section className="py-12 bg-white">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl font-bold text-gray-900 mb-8 text-center">
            Shop by Category
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            {categories.map((cat) => (
              <a
                key={cat.name}
                href="#products"
                className="group block rounded-lg overflow-hidden shadow hover:shadow-lg transition"
              >
                <img
                  src={cat.img}
                  alt={cat.name}
                  className="w-full h-48 object-cover group-hover:scale-105 transition"
                />
                <div className="p-4 text-center">
                  <h3 className="text-xl font-semibold text-gray-800">{cat.name}</h3>
                </div>
              </a>
            ))}
          </div>
        </div>
      </section>

      {/* Featured Products */}
      <section id="products" className="py-12 bg-gray-100">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl font-bold text-gray-900 mb-8 text-center">
            Featured Products
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-8">
            {featured.map((img, idx) => (
              <Link key={idx} href={`/product/${idx + 1}`} className="group block bg-white rounded-lg shadow overflow-hidden hover:shadow-lg transition">
                <img src={img} alt={`Featured ${idx + 1}`} className="w-full h-64 object-cover group-hover:scale-105 transition" />
                <div className="p-4">
                  <h3 className="text-xl font-semibold text-gray-800">Luxury Watch {idx + 1}</h3>
                  <p className="mt-2 text-gray-600">Elegant design with premium leather strap.</p>
                  <p className="mt-4 text-indigo-600 font-bold">$199.00</p>
                  <button className="mt-4 w-full bg-indigo-600 text-white py-2 rounded hover:bg-indigo-700 transition">
                    Add to Cart
                  </button>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </section>

      <Testimonial />

      <footer className="bg-gray-900 text-gray-200 py-12 mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
            <div>
              <h3 className="text-xl font-semibold mb-4">Premium Watch Store</h3>
              <p className="text-gray-400">Elegant watches for every occasion.</p>
            </div>
            <div>
              <h3 className="text-xl font-semibold mb-4">Quick Links</h3>
              <ul className="space-y-2">
                <li><a href="#" className="hover:underline">Home</a></li>
                <li><a href="#products" className="hover:underline">Products</a></li>
                <li><a href="#about" className="hover:underline">About</a></li>
                <li><a href="#contact" className="hover:underline">Contact</a></li>
              </ul>
            </div>
            <div>
              <h3 className="text-xl font-semibold mb-4">Follow Us</h3>
              <div className="flex space-x-4">
                <a href="#" aria-label="Twitter" className="text-gray-400 hover:text-white">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6"><path d="M22.46 6c-.77.35-1.6.58-2.46.69a4.3 4.3 0 001.88-2.37 8.59 8.59 0 01-2.73 1.04 4.28 4.28 0 00-7.3 3.9A12.13 12.13 0 013 4.79a4.28 4.28 0 001.33 5.71 4.24 4.24 0 01-1.94-.54v.05a4.28 4.28 0 003.44 4.2 4.3 4.3 0 01-1.93.07 4.28 4.28 0 003.99 2.97A8.6 8.6 0 012 19.54a12.13 12.13 0 006.56 1.92c7.88 0 12.2-6.53 12.2-12.2 0-.19-.01-.37-.02-.56a8.73 8.73 0 002.14-2.22z"/></svg>
                </a>
                <a href="#" aria-label="Instagram" className="text-gray-400 hover:text-white">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6"><path d="M7 2C4.79 2 3 3.79 3 6v12c0 2.21 1.79 4 4 4h10c2.21 0 4-1.79 4-4V6c0-2.21-1.79-4-4-4H7zm10 2c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H7c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2h10zm-5 3a5 5 0 100 10 5 5 0 000-10zm0 2a3 3 0 110 6 3 3 0 010-6zm4.5-.5a1.5 1.5 0 100 3 1.5 1.5 0 000-3z"/></svg>
                </a>
                <a href="#" aria-label="Facebook" className="text-gray-400 hover:text-white">
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="w-6 h-6"><path d="M22 12c0-5.52-4.48-10-10-10S2 6.48 2 12c0 5 3.66 9.13 8.44 9.88v-6.99H7.9v-2.89h2.54V9.41c0-2.5 1.49-3.89 3.77-3.89 1.09 0 2.24.2 2.24.2v2.46h-1.26c-1.24 0-1.63.77-1.63 1.56v1.88h2.78l-.44 2.89h-2.34v6.99C18.34 21.13 22 17 22 12z"/></svg>
                </a>
              </div>
            </div>
          </div>
          <div className="border-t border-gray-700 mt-8 pt-4 text-center text-gray-500">
            © {new Date().getFullYear()} Premium Watch Store. All rights reserved.
          </div>
        </div>
      </footer>
    </main>
  );
}
