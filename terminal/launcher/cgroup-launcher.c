#define _GNU_SOURCE

#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

extern char **environ;

static int valid_name(const char *value) {
  size_t i;
  if (strncmp(value, "terminal-term_", 14) != 0) return 0;
  if (value[14] == '\0') return 0;
  for (i = 14; value[i] != '\0'; i++) {
    if (!((value[i] >= 'A' && value[i] <= 'Z') || (value[i] >= 'a' && value[i] <= 'z') ||
          (value[i] >= '0' && value[i] <= '9') || value[i] == '_' || value[i] == '-')) return 0;
  }
  return 1;
}

int main(int argc, char **argv) {
  char cgroup[PATH_MAX];
  const char *base;
  int fd;
  int length;

  if (argc < 3) {
    fprintf(stderr, "cgroup launcher: expected cgroup path and executable\n");
    return 125;
  }
  if (realpath(argv[1], cgroup) == NULL) {
    fprintf(stderr, "cgroup launcher: invalid cgroup path: %s\n", strerror(errno));
    return 125;
  }
  base = strrchr(cgroup, '/');
  if (base == NULL || !valid_name(base + 1)) {
    fprintf(stderr, "cgroup launcher: refusing non-terminal cgroup\n");
    return 125;
  }
  length = snprintf(NULL, 0, "%s/cgroup.procs", cgroup);
  if (length < 0 || (size_t)length + 1 >= PATH_MAX) return 125;
  snprintf(cgroup + strlen(cgroup), PATH_MAX - strlen(cgroup), "/cgroup.procs");
  fd = open(cgroup, O_WRONLY | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) {
    fprintf(stderr, "cgroup launcher: cannot join cgroup: %s\n", strerror(errno));
    return 125;
  }
  {
    char pid[32];
    int pid_length = snprintf(pid, sizeof(pid), "%ld\n", (long)getpid());
    if (write(fd, pid, (size_t)pid_length) != pid_length) {
      fprintf(stderr, "cgroup launcher: cannot join cgroup: %s\n", strerror(errno));
      close(fd);
      return 125;
    }
  }
  close(fd);
  execve(argv[2], &argv[2], environ);
  fprintf(stderr, "cgroup launcher: cannot execute %s: %s\n", argv[2], strerror(errno));
  return 126;
}
