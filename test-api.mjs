import fetch from 'node-fetch';

async function run() {
  const res = await fetch('https://raw.githubusercontent.com/evolution-foundation/evolution-go/main/docs/swagger.json');
  const sw = await res.json();
  
  for (let d in sw.definitions) {
     if (JSON.stringify(sw.definitions[d]).toLowerCase().includes('webhook')) {
        console.log(d, sw.definitions[d]);
     }
  }
}
run();
