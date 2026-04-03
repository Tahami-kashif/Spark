import React from 'react';

export default function Testimonial() {
  return (
    <section className="py-12 bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 text-center">
        <h3 className="text-3xl font-bold text-gray-900 mb-6">What Our Customers Say</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          <blockquote className="bg-white p-6 rounded shadow">
            <p className="text-gray-700 italic">“These watches are timeless. The quality is unmatched!”</p>
            <footer className="mt-4 text-right">
              <cite className="text-indigo-600 font-semibold">- Alex Johnson</cite>
            </footer>
          </blockquote>
          <blockquote className="bg-white p-6 rounded shadow">
            <p className="text-gray-700 italic">“I love the design and the comfort. Highly recommend.”</p>
            <footer className="mt-4 text-right">
              <cite className="text-indigo-600 font-semibold">- Maria Garcia</cite>
            </footer>
          </blockquote>
        </div>
      </div>
    </section>
  );
}
