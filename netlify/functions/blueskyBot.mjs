export default async (req) => {
  console.log(`Event now: ${Date.now()}, UTC ${new Date().getTime()}`);
};

// netlify functions:invoke blueskyBot --port 8888
