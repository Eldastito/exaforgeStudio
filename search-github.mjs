import fetch from 'node-fetch';

async function search() {
  const q = encodeURIComponent(`repo:evolution-foundation/evolution-go "instance"`);
  const res = await fetch(`https://api.github.com/search/code?q=${q}`);
  console.log(res.status);
  const data = await res.json();
  if (data.items) {
     for (const item of data.items) {
        console.log(item.path);
     }
  } else {
     console.log(data);
  }
}
search();
