const getOwnerAndRepo = () => {
    const { GITHUB_REPOSITORY } = process.env;
    const [owner, repo] = (GITHUB_REPOSITORY || "").split("/", 2);
  
    if (!owner || !repo) {
      throw new Error(`invalid GITHUB_REPOSITORY value: ${GITHUB_REPOSITORY}`);
    }
    
    return {
        owner,
        repo,
    };
};

module.exports = {
    getOwnerAndRepo,
};